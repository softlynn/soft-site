import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTrack1UploadCopy, removeUploadCopy } from "./pipeline_upload_copy.mjs";
import { createUploadSessionStore } from "./upload_session_store.mjs";
import { uploadFileResumable } from "./pipeline_resumable_upload.mjs";
import { makeUploadedCheckpoint, finalizeAndCompleteUploadedRecording, finalizeRecoveredUpload, recoverUploadedRecordings } from "./pipeline_archive_journal.mjs";
import { createArchiveSnapshotStore, readArchiveDatabase } from "./archive_database.mjs";
import { writeJsonFileAtomic } from "./pipeline_file_io.mjs";
import { findVerifiedUploadCopy, releaseUploadArtifacts } from "./pipeline_upload_lifecycle.mjs";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test("restart across a lost final response and failed completion save preserves one video and original recording", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "soft-pipeline-restart-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, "original.mkv");
  const cacheRoot = path.join(directory, "cache");
  const sessionDirectory = path.join(directory, "sessions");
  const statePath = path.join(directory, "state.json");
  const archivePath = path.join(directory, "vods.json");
  const originalBytes = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251));
  await fs.writeFile(originalPath, originalBytes);
  const stat = await fs.stat(originalPath);
  const recording = {
    path: originalPath, name: "original.mkv", size: stat.size,
    modifiedAtMs: stat.mtimeMs, changedAtMs: stat.ctimeMs, durationSeconds: 3600,
  };
  let preparations = 0;
  const prepare = async (target) => { preparations++; await fs.copyFile(originalPath, target); };
  const prepared = await ensureTrack1UploadCopy(recording, { cacheRoot, prepare });
  const sessionStore = createUploadSessionStore(sessionDirectory, prepared.path);
  const metadata = { snippet: { title: "Fixture stream" }, status: { privacyStatus: "private" } };
  const videoId = "fixture-remote-video";
  let starts = 0;
  let probes = 0;
  let mediaRequests = 0;
  let remoteBytes = 0;
  const request = async (options) => {
    if (options.method === "POST") {
      starts++;
      return { status: 200, headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=integration-fixture" } };
    }
    if (options.headers["Content-Length"] === "0") {
      probes++;
      assert.equal(remoteBytes, originalBytes.length);
      return { status: 201, data: { id: videoId } };
    }
    mediaRequests++;
    const bytes = await collect(options.data);
    assert.equal(options.headers["Content-Range"], `bytes ${remoteBytes}-${remoteBytes + bytes.length - 1}/${originalBytes.length}`);
    assert.deepEqual(bytes, originalBytes.subarray(remoteBytes, remoteBytes + bytes.length));
    remoteBytes += bytes.length;
    if (remoteBytes === originalBytes.length) {
      throw Object.assign(new Error("Fixture lost final response"), { code: "ECONNRESET" });
    }
    return { status: 308, headers: { range: `bytes=0-${remoteBytes - 1}` } };
  };
  await assert.rejects(uploadFileResumable({
    filePath: prepared.path, metadata, request, chunkSizeBytes: 262_144, retryBaseDelayMs: 1,
    loadSession: () => sessionStore.load(),
    saveSession: async (snapshot) => {
      if (snapshot.videoId) throw Object.assign(new Error("Fixture checkpoint disk failure"), { code: "EIO" });
      await sessionStore.save(snapshot);
    },
  }), { code: "EIO" });
  const interruptedSession = await sessionStore.load();
  assert.equal(interruptedSession.finalAttempted, true);
  assert.equal(interruptedSession.videoId, undefined);
  assert.equal(interruptedSession.confirmedBytes, 262_144);

  // Recreate every persistence wrapper as a fresh process would. The cached
  // media and server session must survive both network and local storage loss.
  const restartedCopy = await ensureTrack1UploadCopy(recording, { cacheRoot, prepare });
  const restartedSessionStore = createUploadSessionStore(sessionDirectory, restartedCopy.path);
  assert.equal(restartedCopy.cacheReused, true);
  assert.equal(preparations, 1);
  assert.equal(await uploadFileResumable({
    filePath: restartedCopy.path, metadata, request,
    loadSession: () => restartedSessionStore.load(), saveSession: (snapshot) => restartedSessionStore.save(snapshot),
  }), videoId);
  assert.equal(starts, 1, "restart must not create a second remote upload");
  assert.equal(probes, 2);
  assert.equal(mediaRequests, 2, "accepted media must not be sent again");

  let state = { processedFiles: { [originalPath]: makeUploadedCheckpoint({
    recording, vodEntry: { id: "fixture-twitch", title: "Fixture stream", createdAt: "2026-01-01T00:00:00Z", youtube: [] },
    youtubeVideoId: videoId, partNumber: 1,
  }) } };
  await writeJsonFileAtomic(statePath, state, { durable: true });
  const archive = createArchiveSnapshotStore(archivePath);
  const vods = await archive.read();
  const finalization = {
    readLatestVods: () => archive.read(), configuredPrivacy: "private",
    fetchDetails: async () => ({ durationSeconds: 3600 }),
    setPrivacy: async () => true, syncMetadata: async () => {},
  };
  await assert.rejects(finalizeAndCompleteUploadedRecording({
    state, recordingPath: originalPath, vods, ...finalization,
    persistVods: (rows) => archive.write(rows),
    persistState: async () => { throw Object.assign(new Error("Fixture completion disk failure"), { code: "ENOSPC" }); },
  }), { code: "ENOSPC" });
  assert.equal(state.processedFiles[originalPath].status, "uploaded");
  assert.ok(state.processedFiles[originalPath].pendingVodEntry);
  assert.equal(await releaseUploadArtifacts({
    checkpoint: state.processedFiles[originalPath], recording: restartedCopy,
    sessionStore: restartedSessionStore, removeCopy: () => assert.fail("unfinished upload evidence was removed"),
  }), false);

  state = await readJson(statePath);
  const recoveredArchive = createArchiveSnapshotStore(archivePath);
  assert.equal(await recoverUploadedRecordings({
    state, vods: await recoveredArchive.read(),
    finalizeUpload: (checkpoint) => finalizeRecoveredUpload({
      checkpoint, readLatestVods: () => recoveredArchive.read(),
      fetchDetails: () => assert.fail("persisted video should not need remote finalization again"),
      setPrivacy: () => assert.fail("persisted video privacy should not be replayed"),
      syncMetadata: () => assert.fail("persisted metadata should not be replayed"),
    }),
    persistVods: (rows) => recoveredArchive.write(rows),
    persistState: () => writeJsonFileAtomic(statePath, state, { durable: true }),
  }), 1);
  const completed = (await readJson(statePath)).processedFiles[originalPath];
  assert.equal(completed.status, "completed");
  assert.equal(completed.pendingVodEntry, undefined);
  const archived = await readArchiveDatabase(archivePath);
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].youtube.map((part) => part.id), [videoId]);
  const cleanupCopy = await findVerifiedUploadCopy(originalPath, completed, cacheRoot);
  assert.ok(cleanupCopy);
  assert.equal(await releaseUploadArtifacts({
    checkpoint: completed, recording: cleanupCopy, sessionStore: restartedSessionStore, removeCopy: removeUploadCopy,
  }), true);
  assert.equal(await restartedSessionStore.load(), null);
  await assert.rejects(fs.access(restartedCopy.path), { code: "ENOENT" });
  await assert.rejects(fs.access(restartedCopy.uploadCopyManifestPath), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(originalPath), originalBytes);
});
