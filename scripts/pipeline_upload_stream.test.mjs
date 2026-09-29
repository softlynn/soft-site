import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
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
    readControl: async () => ({ uploadThrottleMbps: 0.06, uploadPaused: sent === 1 && pausedReads++ < 20 }),
    onChunkSent: (bytes) => { if (bytes) { sent++; sentAt.push(now); } },
  });
  stream.wait = async (milliseconds) => { now += milliseconds; };
  try {
    await stream.sendChunk(Buffer.alloc(3072));
    assert.equal(sentAt.length, 3);
    assert.ok(sentAt[2] - sentAt[1] >= 136, "paused time allowed immediate unthrottled chunks");
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
