import assert from "node:assert/strict";
import test from "node:test";
import { isRecordingPending, planRecordingUploads, recordingSourceIdentity, recordingSourceMatches, selectMatchingTwitchVod } from "./pipeline_recordings.mjs";

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

test("a replacement preserving size and mtime is detected by change time and file identity", () => {
  const source = { size: 100, mtimeMs: 1000, ctimeMs: 1200, ino: 42, dev: 8 };
  const identity = recordingSourceIdentity(source);
  assert.deepEqual(identity, { size: 100, modifiedAtMs: 1000, changedAtMs: 1200, fileId: "42", deviceId: "8" });
  assert.equal(recordingSourceMatches(identity, { ...source, ctimeMs: 1300 }), false);
  assert.equal(recordingSourceMatches(identity, { ...source, ino: 43 }), false);
  assert.equal(recordingSourceMatches(identity, source), true);
  assert.equal(recordingSourceMatches(identity, { size: 100, modifiedAtMs: 1000 }), true, "legacy terminal markers stay compatible");
  assert.equal(recordingSourceMatches({ size: null, modifiedAtMs: null }, { size: 0, modifiedAtMs: 0 }), false);
});

test("live overlap is deferred even before its Twitch archive is visible or its stream ID is available", async () => {
  const startedAt = Date.parse("2026-09-01T12:00:00Z");
  const result = await plan([recording("unmatched", { modifiedAtMs: startedAt + 60_000 }), recording("finished", { modifiedAtMs: startedAt - 60_000 })], {
    activeStream: { id: "live", started_at: new Date(startedAt).toISOString() },
  });
  assert.equal(result.skipped[0].reason, "stream_live");
  assert.equal(result.uploads[0].recording.name, "finished");
});

test("a short live segment is never assigned a terminal ignored marker", async () => {
  const result = await plan([recording("live")], {
    probeRecording: async (file) => ({ ...file, durationSeconds: 30 }), activeStream: { id: "live" },
  });
  assert.equal(result.skipped[0].reason, "stream_live");
  assert.equal(result.skipped[0].terminalStatus, undefined);
});

test("pause and abort propagate before expensive probes and between candidates", async () => {
  const paused = Object.assign(new Error("pause fixture"), { code: "SOFTUCHIVE_PAUSED" });
  let probes = 0;
  await assert.rejects(plan([recording("ready")], {
    beforeProbe: () => { throw paused; }, probeRecording: () => { probes++; },
  }), error => error === paused);
  assert.equal(probes, 0);
  const controller = new AbortController();
  await assert.rejects(plan([recording("unmatched"), recording("ready")], {
    signal: controller.signal, probeRecording: async (file) => { probes++; controller.abort(); return { ...file, durationSeconds: 3600 }; },
  }), { name: "AbortError" });
  assert.equal(probes, 1);
});

const epoch = Date.parse("2026-09-01T00:00:00Z");
const vod = (id, hour, hours = 1, extra = {}) => ({ id, user_id: "42", user_login: "softxu", type: "archive", created_at: new Date(epoch + hour * 3600_000).toISOString(), duration: `${hours}h`, ...extra });
const timed = (startHour, endHour) => ({ startAtMs: epoch + startHour * 3600_000, endAtMs: epoch + endHour * 3600_000 });

test("later recording parts match the stream containing most footage, not the closest next start", () => {
  const earlier = vod("earlier", 10, 3);
  const next = vod("next", 13, 2);
  assert.equal(selectMatchingTwitchVod(timed(12, 13.1), [next, earlier]).id, "earlier");
  assert.equal(selectMatchingTwitchVod(timed(10, 11), [earlier]).id, "earlier");
  assert.equal(selectMatchingTwitchVod(timed(11, 12), [earlier]).id, "earlier");
  assert.equal(selectMatchingTwitchVod(timed(12, 13), [earlier]).id, "earlier");
});

test("matching filters foreign channels, highlights, malformed timing, and exact ambiguities", () => {
  const wanted = vod("wanted", 10, 2);
  const candidates = [vod("foreign", 10, 2, { user_id: "99", user_login: "other" }), wanted];
  assert.equal(selectMatchingTwitchVod(timed(10, 11), candidates, { expectedUserId: "42", expectedLogin: "softxu" }).id, "wanted");
  for (const invalid of [vod("highlight", 10, 2, { type: "highlight" }), vod("bad-duration", 10, 2, { duration: "N/A" }), vod("bad-date", 10, 2, { created_at: "no date" }), vod("wrong-login", 10, 2, { user_login: "other" })]) {
    assert.equal(selectMatchingTwitchVod(timed(10, 11), [invalid], { expectedUserId: "42", expectedLogin: "softxu" }), null);
  }
  assert.equal(selectMatchingTwitchVod(timed(10, 11), [wanted, vod("duplicate", 10, 2)]), null);
  assert.equal(selectMatchingTwitchVod(timed(12.1, 12.2), [wanted]), null, "a recording entirely after the archive is not proven to belong to it");
  assert.equal(selectMatchingTwitchVod({ startAtMs: null, endAtMs: null }, [wanted]), null);
  assert.equal(selectMatchingTwitchVod(timed(11, 10), [wanted]), null);
});

test("parts crossing midnight stay with their actual stream while a not-yet-complete archive stays retryable", async () => {
  const overnight = vod("overnight", 23, 4);
  const nextDay = vod("next-day", 28, 2);
  assert.equal(selectMatchingTwitchVod(timed(24.5, 26), [nextDay, overnight]).id, "overnight");
  assert.equal(selectMatchingTwitchVod(timed(28, 29), [overnight]), null);
  const latePart = recording("late-part", { ...timed(25, 26), modifiedAtMs: epoch + 26 * 3600_000 });
  const incomplete = vod("overnight", 23, 1);
  const result = await plan([latePart], {
    matchVod: file => selectMatchingTwitchVod(file, [incomplete]),
    activeStream: { id: "ongoing", started_at: overnight.created_at },
  });
  assert.equal(result.skipped[0].reason, "stream_live");
  assert.equal(result.skipped[0].terminalStatus, undefined);
  assert.equal(selectMatchingTwitchVod(latePart, [overnight]).id, "overnight", "the finalized archive permits retry after the stream ends");
});
