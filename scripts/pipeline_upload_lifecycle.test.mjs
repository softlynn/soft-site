import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTrack1UploadCopy, removeUploadCopy } from "./pipeline_upload_copy.mjs";
import { createUploadSessionStore } from "./upload_session_store.mjs";
import { findVerifiedUploadCopy, releaseUploadArtifacts } from "./pipeline_upload_lifecycle.mjs";

const withCopy = async (run) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-lifecycle-"));
  try {
    const sourcePath = path.join(dir, "source.mkv");
    await fs.writeFile(sourcePath, "original recording");
    const stat = await fs.stat(sourcePath);
    const source = { path: sourcePath, size: stat.size, modifiedAtMs: stat.mtimeMs };
    const copy = await ensureTrack1UploadCopy(source, { cacheRoot: dir, prepare: (output) => fs.writeFile(output, "generated upload bytes") });
    const sessionStore = createUploadSessionStore(path.join(dir, "sessions"), copy.path);
    await sessionStore.save({ finalAttempted: false, confirmedBytes: 5 });
    await run({ dir, source, copy, sessionStore });
    assert.equal(await fs.readFile(sourcePath, "utf8"), "original recording");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("pause, error, and uploaded journal states preserve byte-identical copy, manifest, and session", async () => {
  await withCopy(async ({ copy, sessionStore }) => {
    const before = await fs.stat(copy.path);
    for (const status of ["paused", "error", "uploaded", "processing"]) {
      assert.equal(await releaseUploadArtifacts({ checkpoint: { status }, recording: copy, sessionStore, removeCopy: removeUploadCopy }), false);
    }
    const after = await fs.stat(copy.path);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal(await fs.readFile(copy.path, "utf8"), "generated upload bytes");
    assert.equal((await sessionStore.load()).confirmedBytes, 5);
    await fs.access(copy.uploadCopyManifestPath);
  });
});

test("completed cleanup deletes only the generated copy, manifest, and private session", async () => {
  await withCopy(async ({ copy, sessionStore }) => {
    assert.equal(await releaseUploadArtifacts({ checkpoint: { status: "completed" }, recording: copy, sessionStore, removeCopy: removeUploadCopy }), true);
    await assert.rejects(fs.access(copy.path), { code: "ENOENT" });
    await assert.rejects(fs.access(copy.uploadCopyManifestPath), { code: "ENOENT" });
    assert.equal(await sessionStore.load(), null);
  });
});

test("manual skip retains an uncertain final request and only clears an explicitly unfinished session", async () => {
  await withCopy(async ({ copy, sessionStore }) => {
    await sessionStore.save({ finalAttempted: true, confirmedBytes: 5 });
    assert.equal(await releaseUploadArtifacts({ checkpoint: { status: "skipped_manual" }, recording: copy, sessionStore, removeCopy: removeUploadCopy }), false);
    await fs.access(copy.path);
    await sessionStore.save(null);
    assert.equal(await releaseUploadArtifacts({ checkpoint: { status: "skipped_manual" }, recording: copy, sessionStore, removeCopy: removeUploadCopy }), false);
    await fs.access(copy.path);
    await sessionStore.save({ finalAttempted: false, confirmedBytes: 5 });
    assert.equal(await releaseUploadArtifacts({ checkpoint: { status: "skipped_manual" }, recording: copy, sessionStore, removeCopy: removeUploadCopy }), true);
    assert.equal(await sessionStore.load(), null);
  });
});

test("recovery locates only a manifest matching the durable original source fingerprint", async () => {
  await withCopy(async ({ source, copy, dir }) => {
    const checkpoint = { status: "completed", source: { size: source.size, modifiedAtMs: source.modifiedAtMs } };
    const recovered = await findVerifiedUploadCopy(source.path, checkpoint, dir);
    assert.equal(recovered.path, copy.path);
    assert.equal(recovered.originalPath, source.path);
    const manifest = JSON.parse(await fs.readFile(copy.uploadCopyManifestPath, "utf8"));
    manifest.source.path = path.join(dir, "different-original.mkv");
    await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify(manifest));
    assert.equal(await findVerifiedUploadCopy(source.path, checkpoint, dir), null);
    assert.equal(await findVerifiedUploadCopy(source.path, { status: "completed" }, dir), null);
  });
});

test("cleanup failures retain the session so a later poll can finish cleanup", async () => {
  await withCopy(async ({ copy, sessionStore }) => {
    await assert.rejects(releaseUploadArtifacts({ checkpoint: { status: "ignored_short_uploaded" }, recording: copy, sessionStore, removeCopy: async () => { throw new Error("file busy"); } }), /file busy/);
    assert.equal((await sessionStore.load()).confirmedBytes, 5);
    await fs.access(copy.path);
  });
});

test("session cleanup failure keeps the manifest so the next poll can finish after media deletion", async () => {
  await withCopy(async ({ source, copy, dir, sessionStore }) => {
    const checkpoint = { status: "completed", source: { size: source.size, modifiedAtMs: source.modifiedAtMs } };
    const failingStore = { ...sessionStore, save: async () => { throw new Error("session busy"); } };
    await assert.rejects(releaseUploadArtifacts({ checkpoint, recording: copy, sessionStore: failingStore, removeCopy: removeUploadCopy }), /session busy/);
    await assert.rejects(fs.access(copy.path), { code: "ENOENT" });
    await fs.access(copy.uploadCopyManifestPath);
    assert.equal((await sessionStore.load()).confirmedBytes, 5);
    const recovered = await findVerifiedUploadCopy(source.path, checkpoint, dir);
    assert.equal(recovered.path, copy.path);
    assert.equal(await releaseUploadArtifacts({ checkpoint, recording: recovered, sessionStore, removeCopy: removeUploadCopy }), true);
    assert.equal(await sessionStore.load(), null);
    await assert.rejects(fs.access(copy.uploadCopyManifestPath), { code: "ENOENT" });
  });
});

test("cleanup recovery rejects a malformed output identity even after the media is gone", async () => {
  await withCopy(async ({ source, copy, dir }) => {
    const checkpoint = { status: "completed", source: { size: source.size, modifiedAtMs: source.modifiedAtMs } };
    const manifest = JSON.parse(await fs.readFile(copy.uploadCopyManifestPath, "utf8"));
    await fs.rm(copy.path);
    delete manifest.output;
    await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify(manifest));
    assert.equal(await findVerifiedUploadCopy(source.path, checkpoint, dir), null);
  });
});

test("cleanup recovery rejects a copy whose recorded output identity changed", async () => {
  await withCopy(async ({ source, copy, dir }) => {
    const checkpoint = { status: "completed", source: { size: source.size, modifiedAtMs: source.modifiedAtMs } };
    const manifest = JSON.parse(await fs.readFile(copy.uploadCopyManifestPath, "utf8"));
    manifest.output.changedAtMs -= 1;
    await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify(manifest));
    assert.equal(await findVerifiedUploadCopy(source.path, checkpoint, dir), null);
  });
});

test("old terminal checkpoints cannot clean a newer source with the same size and modification time", async () => {
  await withCopy(async ({ source, copy, dir }) => {
    const originalIdentity = { size: source.size, modifiedAtMs: source.modifiedAtMs, changedAtMs: 1000, fileId: "123", deviceId: "456" };
    const checkpoint = { status: "completed", source: originalIdentity };
    const manifest = JSON.parse(await fs.readFile(copy.uploadCopyManifestPath, "utf8"));
    for (const [key, replacement] of [["changedAtMs", 2000], ["fileId", "234"], ["deviceId", "567"]]) {
      manifest.source = { ...source, ...originalIdentity, [key]: replacement };
      await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify(manifest));
      assert.equal(await findVerifiedUploadCopy(source.path, checkpoint, dir), null, `${key} mismatch allowed cleanup`);
    }
    manifest.source = { ...source, ...originalIdentity };
    await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify(manifest));
    assert.equal((await findVerifiedUploadCopy(source.path, checkpoint, dir)).path, copy.path);
    await fs.access(copy.path);
  });
});
