import assert from "node:assert/strict";
import test from "node:test";
import {
  SOFTUCHIVE_PAUSE_ERROR_CODE,
  SOFTUCHIVE_SKIP_ERROR_CODE,
  createPipelineControlError,
  normalizeUploadThrottleMbps,
} from "./pipeline_control.mjs";

test("upload throttle accepts only finite positive numbers or numeric strings", () => {
  for (const unset of [null, undefined, ""]) {
    assert.equal(normalizeUploadThrottleMbps(unset), null, `${String(unset)} must mean no limit`);
  }
  assert.equal(normalizeUploadThrottleMbps(5), 5);
  assert.equal(normalizeUploadThrottleMbps("4.5"), 4.5);
  assert.equal(normalizeUploadThrottleMbps(" 7 "), 7);
  assert.equal(normalizeUploadThrottleMbps(6.257), 6.26, "limits are rounded to two decimals");
  for (const text of ["abc", "Infinity", "NaN", "1e400"]) {
    assert.equal(normalizeUploadThrottleMbps(text), null, `${text} is not a limit`);
  }
  // Number() would coerce these to 1, 5 and 0; a limit must be an explicit number.
  for (const coercible of [true, false, [5], {}, { valueOf: () => 5 }, new Date(5), () => 5]) {
    assert.equal(normalizeUploadThrottleMbps(coercible), null);
  }
  for (const nonPositive of [0, -10, "-3", -Infinity, NaN]) {
    assert.equal(normalizeUploadThrottleMbps(nonPositive), null, `${String(nonPositive)} is not a limit`);
  }
  assert.equal(normalizeUploadThrottleMbps(0.001), 0.01, "tiny limits clamp to the minimum");
  assert.equal(normalizeUploadThrottleMbps(50_000), 10_000, "huge limits clamp to the maximum");
  assert.equal(normalizeUploadThrottleMbps("10000.004"), 10_000);
});

test("control errors carry the shared pause and skip codes", () => {
  assert.equal(SOFTUCHIVE_PAUSE_ERROR_CODE, "SOFTUCHIVE_PAUSED");
  assert.equal(SOFTUCHIVE_SKIP_ERROR_CODE, "SOFTUCHIVE_SKIPPED");
  const paused = createPipelineControlError("Pause requested.", SOFTUCHIVE_PAUSE_ERROR_CODE);
  assert.ok(paused instanceof Error);
  assert.equal(paused.message, "Pause requested.");
  assert.equal(paused.code, SOFTUCHIVE_PAUSE_ERROR_CODE);
  assert.equal(createPipelineControlError("Skip requested.", SOFTUCHIVE_SKIP_ERROR_CODE).code, SOFTUCHIVE_SKIP_ERROR_CODE);
});
