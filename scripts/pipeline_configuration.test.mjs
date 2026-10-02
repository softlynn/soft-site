import assert from "node:assert/strict";
import test from "node:test";
import { validatePipelineState, validatePipelineConfiguration } from "./pipeline_configuration.mjs";

test("wrong-shaped recovery history fails closed instead of losing filename keys on JSON serialization", () => {
  for (const state of [[], null, { processedFiles: [] }, { processedFiles: null }, { processedFiles: { file: [] } }, { processedVodIds: false }]) {
    assert.throws(() => validatePipelineState(state), /refusing to replace recovery history/);
  }
  assert.deepEqual(validatePipelineState({}), { processedFiles: {}, processedVodIds: {} });
});

test("numeric typos cannot silently disable recording discovery or remove age safety", () => {
  const valid = { youtubePrivacyStatus: "private", minRecordingAgeMinutes: 10, maxRecordingsPerRun: 1, minArchiveVodDurationSeconds: 300, autoMergeVodGapSeconds: 0, youtubeVisibilitySyncIntervalMinutes: 180 };
  validatePipelineConfiguration(valid);
  for (const [key, value] of [["minRecordingAgeMinutes", NaN], ["minRecordingAgeMinutes", -1], ["maxRecordingsPerRun", Infinity], ["maxRecordingsPerRun", 1.5], ["autoMergeVodGapSeconds", -1]]) {
    assert.throws(() => validatePipelineConfiguration({ ...valid, [key]: value }), /must be a finite/);
  }
  assert.throws(() => validatePipelineConfiguration({ ...valid, youtubePrivacyStatus: "publc" }), /YOUTUBE_PRIVACY_STATUS/);
});
