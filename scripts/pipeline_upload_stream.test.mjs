import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
