import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertRecordingUploadRecoverySafe, makeTerminalRecordingDeferral } from "./pipeline_recording_recovery.mjs";
import { buildTrack1UploadCopyPath, ensureTrack1UploadCopy } from "./pipeline_upload_copy.mjs";
import { isRecordingPending, planRecordingUploads, recordingSourceIdentity } from "./pipeline_recordings.mjs";
import { createUploadSessionStore } from "./upload_session_store.mjs";

const RECOVERY_REQUIRED = { code: "SOFTUCHIVE_RECORDING_RECOVERY_REQUIRED" };
const snapshot = async (filePath) => ({ path: filePath, name: path.basename(filePath), ...recordingSourceIdentity(await fs.stat(filePath)) });
const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.mkv");
  await fs.writeFile(sourcePath, "synthetic recording bytes");
  const recording = await snapshot(sourcePath);
  const cacheRoot = path.join(root, "cache");
  const sessionDirectory = path.join(root, "sessions");
  const checkpoint = { status: "error", source: recordingSourceIdentity(recording), uploadSessionId: "fixture-ui-session" };
  return { root, recording, checkpoint, cacheRoot, sessionDirectory };
};
const saveSession = async (directory, preparedPath, extra = {}) => {
  const session = { version: 1, fingerprint: { path: path.resolve(preparedPath), size: 12, mtimeNs: "1", ctimeNs: "1" },
    finalAttempted: true, confirmedBytes: 12, url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=PRIVATE_FIXTURE", ...extra };
  const store = createUploadSessionStore(directory, preparedPath);
  await store.save(session);
  return { session, store };
};

test("clean recordings and unrelated resumable uploads continue without changing evidence", async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.recording.path);
  const expected = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  assert.deepEqual(await assertRecordingUploadRecoverySafe({ ...f, checkpoint: undefined }), { expectedCopyPath: expected, preparedUploadCopy: null });
  const unrelatedPath = buildTrack1UploadCopyPath({ ...f.recording, path: path.join(f.root, "different.mkv") }, path.join(f.root, "old-cache"));
  const unrelated = await saveSession(f.sessionDirectory, unrelatedPath);
  await assertRecordingUploadRecoverySafe({ ...f, checkpoint: undefined });
  assert.deepEqual(await unrelated.store.load(), unrelated.session);
  assert.deepEqual(await fs.readFile(f.recording.path), original);
});

test("an unchanged recording resumes the same prepared copy and private session", async (t) => {
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.recording, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "exact saved copy") });
  const { store, session } = await saveSession(f.sessionDirectory, copy.path);
  const checkpoint = { ...f.checkpoint, preparedUploadCopy: copy };
  const before = structuredClone(checkpoint);
  const result = await assertRecordingUploadRecoverySafe({ ...f, checkpoint });
  assert.equal(result.expectedCopyPath, copy.path);
  assert.deepEqual(result.preparedUploadCopy, copy);
  assert.deepEqual(checkpoint, before, "guard must not replace a processing checkpoint");
  assert.deepEqual(await store.load(), session);
  assert.equal(await fs.readFile(copy.path, "utf8"), "exact saved copy");
});

for (const changedField of ["size", "modifiedAtMs", "changedAtMs", "fileId"]) {
  test(`${changedField} drift blocks before a second copy or upload can start`, async (t) => {
    const f = await fixture(t);
    const oldCopy = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
    const { store, session } = await saveSession(f.sessionDirectory, oldCopy);
    const changed = { ...f.recording, [changedField]: changedField === "fileId" ? `${f.recording.fileId}-replacement` : f.recording[changedField] + 1 };
    let prepared = 0;
    await assert.rejects((async () => {
      await assertRecordingUploadRecoverySafe({ ...f, recording: changed });
      prepared++;
    })(), RECOVERY_REQUIRED);
    assert.equal(prepared, 0);
    assert.deepEqual(await store.load(), session);
    assert.equal(f.checkpoint.status, "error");
  });
}

test("changing tmpDir cannot bypass a legacy unpinned session after an uncertain final request", async (t) => {
  const f = await fixture(t);
  const oldCopy = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  const newCache = path.join(f.root, "new-cache");
  const nextCopy = buildTrack1UploadCopyPath(f.recording, newCache);
  assert.equal(path.basename(oldCopy), path.basename(nextCopy));
  const { store, session } = await saveSession(f.sessionDirectory, oldCopy);
  await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, cacheRoot: newCache }), RECOVERY_REQUIRED);
  assert.deepEqual(await store.load(), session);
  await assert.rejects(fs.access(newCache), { code: "ENOENT" }, "no replacement media/cache directory is created");
});

test("an orphan session is discovered after the legacy worker marker was lost", async (t) => {
  const f = await fixture(t);
  const oldCopy = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  const { store, session } = await saveSession(f.sessionDirectory, oldCopy);
  await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, checkpoint: undefined, cacheRoot: path.join(f.root, "new-cache") }), RECOVERY_REQUIRED);
  assert.deepEqual(await store.load(), session);
});

test("pinned prepared location rejects cache drift even when the private session cannot be found", async (t) => {
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.recording, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "copy") });
  await assert.rejects(assertRecordingUploadRecoverySafe({ ...f,
    checkpoint: { ...f.checkpoint, preparedUploadCopy: copy }, cacheRoot: path.join(f.root, "moved-cache") }), RECOVERY_REQUIRED);
  await fs.access(copy.path);
  await fs.access(copy.uploadCopyManifestPath);
});

test("invalid pins and missing legacy source fingerprints fail closed", async (t) => {
  const f = await fixture(t);
  for (const checkpoint of [
    { status: "processing" }, { ...f.checkpoint, source: {} },
    { ...f.checkpoint, youtubeVideoId: "already-uploaded" },
    { ...f.checkpoint, preparedUploadCopy: { path: buildTrack1UploadCopyPath(f.recording, f.cacheRoot), originalPath: f.recording.path } },
  ]) await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, checkpoint }), RECOVERY_REQUIRED);
});

test("a completed older source does not prevent a genuinely new recording version", async (t) => {
  const f = await fixture(t);
  await assertRecordingUploadRecoverySafe({ ...f, recording: { ...f.recording, size: f.recording.size + 1 },
    checkpoint: { ...f.checkpoint, status: "completed", youtubeVideoId: "archived-video" } });
});

test("an uncleared manual skip preserves final-request ambiguity when the source changes", async (t) => {
  const f = await fixture(t);
  const oldCopy = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  const { session, store } = await saveSession(f.sessionDirectory, oldCopy);
  const changed = { ...f.recording, modifiedAtMs: f.recording.modifiedAtMs + 1 };
  const checkpoint = { ...f.checkpoint, status: "skipped_manual" };
  await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, recording: changed, checkpoint }), RECOVERY_REQUIRED);
  assert.deepEqual(await store.load(), session);
  await store.save(null);
  await assertRecordingUploadRecoverySafe({ ...f, recording: changed, checkpoint: { ...checkpoint, uploadArtifactsClearedAt: new Date().toISOString() } });
});

test("unreadable private evidence is bounded, preserved, and never exposed in error text", async (t) => {
  const f = await fixture(t);
  const expected = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  await saveSession(f.sessionDirectory, expected);
  const [name] = await fs.readdir(f.sessionDirectory);
  const privatePath = path.join(f.sessionDirectory, name);
  for (const contents of ["{PRIVATE_FIXTURE invalid", JSON.stringify({ version: 1, url: "PRIVATE_FIXTURE" }), "PRIVATE_FIXTURE".repeat(100)]) {
    await fs.writeFile(privatePath, contents);
    await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, maxSessionBytes: 512 }), error => {
      assert.equal(error.code, RECOVERY_REQUIRED.code);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE|upload_id/);
      return true;
    });
    assert.equal(await fs.readFile(privatePath, "utf8"), contents);
  }
});

test("checkpoint inspection rejects identity/key mismatch and excessive entry counts", async (t) => {
  const f = await fixture(t);
  const expected = buildTrack1UploadCopyPath(f.recording, f.cacheRoot);
  const { session } = await saveSession(f.sessionDirectory, expected);
  const [name] = await fs.readdir(f.sessionDirectory);
  await fs.writeFile(path.join(f.sessionDirectory, name), JSON.stringify({ ...session, fingerprint: { ...session.fingerprint, path: `${expected}-other` } }));
  await assert.rejects(assertRecordingUploadRecoverySafe(f), RECOVERY_REQUIRED);
  await fs.writeFile(path.join(f.sessionDirectory, name), JSON.stringify(session));
  await fs.writeFile(path.join(f.sessionDirectory, "unrelated.tmp"), "fixture");
  await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, maxEntries: 1 }), RECOVERY_REQUIRED);
  assert.equal((await fs.readdir(f.sessionDirectory)).length, 2);
});

for (const status of ["error", "paused"]) {
  test(`raising the duration minimum preserves ${status} upload evidence and still blocks a later changed source`, async (t) => {
    const f = await fixture(t);
    const copy = await ensureTrack1UploadCopy(f.recording, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "uncertain uploaded bytes") });
    const { store, session } = await saveSession(f.sessionDirectory, copy.path);
    const checkpoint = { ...f.checkpoint, status, preparedUploadCopy: copy };
    const before = structuredClone(checkpoint);
    await assertRecordingUploadRecoverySafe({ ...f, checkpoint });
    const { uploads, skipped } = await planRecordingUploads({
      recordings: [f.recording], maxUploads: 1, minimumDurationSeconds: 1000,
      probeRecording: async recording => ({ ...recording, durationSeconds: 600 }),
      matchVod: () => ({ id: "prior-stream", stream_id: "prior-stream" }), verifyRecording: async () => true,
    });
    assert.equal(uploads.length, 0);
    assert.equal(skipped[0].terminalStatus, "ignored_short");
    assert.equal(makeTerminalRecordingDeferral(skipped[0].recording, skipped[0].terminalStatus, checkpoint), null,
      "a policy skip must not create a replacement terminal checkpoint");
    assert.deepEqual(checkpoint, before);
    const changedSource = { ...f.recording, modifiedAtMs: f.recording.modifiedAtMs + 1 };
    assert.equal(isRecordingPending(changedSource, checkpoint), true);
    await assert.rejects(assertRecordingUploadRecoverySafe({ ...f, recording: changedSource, checkpoint }), RECOVERY_REQUIRED);
    assert.deepEqual(await store.load(), session);
    assert.equal(await fs.readFile(copy.path, "utf8"), "uncertain uploaded bytes");
    await fs.access(copy.uploadCopyManifestPath);
  });
}

test("ordinary new short recordings and completed-source replacements can still receive terminal deferrals", async (t) => {
  const f = await fixture(t);
  const recording = { ...f.recording, durationSeconds: 42.5, modifiedAtMs: f.recording.modifiedAtMs + 1 };
  for (const prior of [undefined, { ...f.checkpoint, status: "completed", youtubeVideoId: "known-prior-video" }]) {
    const deferred = makeTerminalRecordingDeferral(recording, "ignored_short", prior);
    assert.equal(deferred.status, "ignored_short");
    assert.deepEqual(deferred.source, recordingSourceIdentity(recording));
    assert.equal(deferred.durationSeconds, 42);
    assert.equal(isRecordingPending(recording, deferred), false);
  }
});
