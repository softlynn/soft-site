import assert from "node:assert/strict";
import test from "node:test";
import { isRecordingPending, planRecordingUploads, recordingSourceMatches } from "./pipeline_recordings.mjs";

const recording = (name, extra = {}) => ({ path: `/recordings/${name}.mkv`, name, size: 100, modifiedAtMs: 1000, ...extra });
const plan = (recordings, extra = {}) => planRecordingUploads({
  recordings, maxUploads: 1, minimumDurationSeconds: 300,
  probeRecording: async (file) => ({ ...file, durationSeconds: 3600 }),
  matchVod: (file) => file.name === "unmatched" ? null : { id: file.name, stream_id: file.name },
  verifyRecording: async () => true,
  ...extra,
});

test("an unmatched oldest recording does not starve a later matched recording", async () => {
  const result = await plan([recording("unmatched"), recording("ready"), recording("later")]);
  assert.deepEqual(result.uploads.map(({ twitchVod }) => twitchVod.id), ["ready"]);
  assert.equal(result.skipped[0].reason, "unmatched");
});

test("a transient probe failure stays retryable and does not consume the upload limit", async () => {
  const first = recording("probe-failed");
  const result = await plan([first, recording("ready")], {
    probeRecording: async (file) => ({ ...file, durationSeconds: file === first ? null : 3600 }),
  });
  assert.equal(result.skipped[0].reason, "duration_unavailable");
  assert.equal(result.skipped[0].terminalStatus, undefined);
  assert.deepEqual(result.uploads.map(({ twitchVod }) => twitchVod.id), ["ready"]);
  assert.equal(isRecordingPending(first, { status: "ignored_unknown_duration" }), true);
});

test("a changed source can be processed again while a completed unchanged source is skipped", () => {
  const file = recording("ready");
  const processed = { status: "completed", source: { size: 100, modifiedAtMs: 1000 } };
  assert.equal(isRecordingPending(file, processed), false);
  assert.equal(isRecordingPending({ ...file, size: 200 }, processed), true);
  assert.equal(isRecordingPending(file, { status: "completed" }), false, "legacy completed records must not duplicate uploads");
  assert.equal(recordingSourceMatches(file, { size: 100, mtimeMs: 1001 }), false);
});

test("a source that changes while probing is deferred", async () => {
  const result = await plan([recording("growing"), recording("ready")], {
    verifyRecording: async (file) => file.name !== "growing",
  });
  assert.equal(result.skipped[0].reason, "source_changed");
  assert.deepEqual(result.uploads.map(({ twitchVod }) => twitchVod.id), ["ready"]);
});

test("finished OBS segments from the active Twitch stream are deferred", async () => {
  const result = await plan([recording("live"), recording("finished")], { activeStream: { id: "live" } });
  assert.equal(result.skipped[0].reason, "stream_live");
  assert.deepEqual(result.uploads.map(({ twitchVod }) => twitchVod.id), ["finished"]);
});
