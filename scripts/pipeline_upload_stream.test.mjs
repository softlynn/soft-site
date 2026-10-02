import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { getEventListeners } from "node:events";
import { DynamicUploadThrottleStream, getUploadHealthState } from "./pipeline_upload_stream.mjs";

test("an intentional upload pause resets the stall clock and resumes without a retry", () => {
  const paused = getUploadHealthState({ nowMs: 300_000, lastByteProgressAtMs: 1_000, stallTimeoutMs: 120_000, uploadPaused: true });
  assert.equal(paused.stalled, false);
  const resumed = getUploadHealthState({ nowMs: 302_000, lastByteProgressAtMs: paused.lastByteProgressAtMs, stallTimeoutMs: 120_000 });
  assert.equal(resumed.stalled, false);
  const stalled = getUploadHealthState({ nowMs: 420_000, lastByteProgressAtMs: resumed.lastByteProgressAtMs, stallTimeoutMs: 120_000 });
  assert.equal(stalled.stalled, true);
});

test("destroying a paused upload stops control polling and pending waits", async () => {
  let paused = true;
  let reads = 0;
  const stream = new DynamicUploadThrottleStream({
    readControl: async () => { reads++; return { uploadPaused: paused }; },
  });
  stream.on("error", () => {});
  stream.write(Buffer.from("recording"), () => {});
  await delay(10);
  stream.destroy();
  const before = reads;
  try {
    await delay(550);
    assert.equal(reads, before, "destroyed upload kept polling controls");
  } finally {
    paused = false;
  }
});

test("pause then resume delivers all bytes and manual skip retains its control error", async () => {
  let paused = true;
  const stream = new DynamicUploadThrottleStream({ readControl: async () => ({ uploadPaused: paused }) });
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.end(Buffer.from("recording bytes"));
  await delay(10);
  assert.equal(chunks.length, 0);
  paused = false;
  await new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  assert.equal(Buffer.concat(chunks).toString(), "recording bytes");

  const skipped = new DynamicUploadThrottleStream({ readControl: async () => ({ skipRequested: true }) });
  const error = new Promise((resolve) => skipped.once("error", resolve));
  skipped.end(Buffer.from("skip me"));
  assert.equal((await error).code, "SOFTUCHIVE_SKIPPED");
});

test("resuming a paused upload does not spend pause time on a burst above its speed limit", async (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  let sent = 0;
  let pausedReads = 0;
  const sentAt = [];
  const stream = new DynamicUploadThrottleStream({
    readControl: async () => ({ uploadThrottleMbps: 0.08, uploadPaused: sent === 1 && pausedReads++ < 20 }),
    onChunkSent: (bytes) => { if (bytes) { sent++; sentAt.push(now); } },
  });
  stream.wait = async (milliseconds) => { now += milliseconds; };
  try {
    await stream.sendChunk(Buffer.alloc(3750));
    assert.equal(sentAt.length, 3);
    assert.ok(sentAt[2] - sentAt[1] >= 125, "paused time allowed immediate unthrottled chunks");
  } finally { stream.destroy(); }
});

test("large input chunks stop at readable backpressure and resume without losing bytes", async () => {
  const input = Buffer.alloc(2 * 1024 * 1024, 0x73);
  let sent = 0;
  let finished = false;
  const stream = new DynamicUploadThrottleStream({ onChunkSent: (bytes) => { sent += bytes; } });
  stream.end(input, () => { finished = true; });
  await immediate();
  assert.equal(sent, stream.readableLength);
  assert.ok(sent <= stream.readableHighWaterMark + 64 * 1024);
  assert.equal(finished, false, "transformed all input while the destination was blocked");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), input);
  assert.equal(finished, true);
  assert.equal(stream.resumeReadable, null);
});

test("destroying a backpressured upload releases its pending write", async () => {
  const stream = new DynamicUploadThrottleStream();
  stream.on("error", () => {});
  const pendingWrite = new Promise((resolve) => stream.write(Buffer.alloc(1024 * 1024), resolve));
  await immediate();
  assert.equal(typeof stream.resumeReadable, "function");
  stream.destroy();
  const error = await pendingWrite;
  assert.equal(error.code, "ERR_STREAM_DESTROYED");
  assert.equal(stream.resumeReadable, null);
});

test("destroying an upload interrupts an unresolved control read and releases its abort listener", async () => {
  let controlReadStarted;
  const started = new Promise((resolve) => { controlReadStarted = resolve; });
  const stream = new DynamicUploadThrottleStream({ readControl: () => {
    controlReadStarted();
    return new Promise(() => {});
  } });
  stream.on("error", () => {});
  const pendingWrite = new Promise((resolve) => stream.write(Buffer.from("recording"), resolve));
  await started;
  stream.destroy();
  assert.equal((await pendingWrite).code, "ERR_STREAM_DESTROYED");
  assert.equal(getEventListeners(stream.waitController.signal, "abort").length, 0);
});

test("high limits compensate timer rounding instead of imposing a 64 KiB per millisecond cap", async (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  const stream = new DynamicUploadThrottleStream({ readControl: async () => ({ uploadThrottleMbps: 1000 }) });
  let waits = 0;
  stream.wait = async (milliseconds) => { waits++; now += milliseconds; };
  try {
    const start = now;
    const inputBytes = 8 * 1024 * 1024;
    stream.end(Buffer.alloc(inputBytes));
    let received = 0;
    for await (const chunk of stream) received += chunk.length;
    assert.equal(received, inputBytes);
    const expectedMs = inputBytes / (1_000_000_000 / 8) * 1000;
    assert.ok(now - start >= expectedMs, "upload exceeded its limit");
    assert.ok(now - start < expectedMs + 2, "timer rounding unnecessarily halved upload speed");
    assert.ok(waits < inputBytes / (64 * 1024));
  } finally { stream.destroy(); }
});

test("the lowest speed limit checks controls within 125 ms and emits no bytes after skip", async (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  let skipped = false;
  const waits = [];
  const chunks = [];
  const stream = new DynamicUploadThrottleStream({
    readControl: async () => ({ uploadThrottleMbps: 0.01, skipRequested: skipped }),
    onChunkSent: (bytes) => { if (bytes) skipped = true; },
  });
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.wait = async (milliseconds) => { waits.push(milliseconds); now += milliseconds; };
  try {
    await assert.rejects(stream.sendChunk(Buffer.alloc(2048)), { code: "SOFTUCHIVE_SKIPPED" });
    assert.equal(chunks.length, 1);
    assert.ok(waits.every((milliseconds) => milliseconds <= 125));
    assert.equal(chunks[0].length, 156);
  } finally { stream.destroy(); }
});

test("a slow destination does not build up credit for an upload burst", async (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  const stream = new DynamicUploadThrottleStream();
  const waits = [];
  stream.wait = async (milliseconds) => { waits.push(milliseconds); now += milliseconds; };
  try {
    await stream.waitForThrottle(1024, 0.06);
    now += 10_000;
    await stream.waitForThrottle(1024, 0.06);
    assert.equal(waits.length, 2, "destination idle time accumulated upload credit");
    assert.ok(waits[1] >= 136);
  } finally { stream.destroy(); }
});
