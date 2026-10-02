import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArchiveSnapshotStore, readArchiveDatabase, updateArchiveDatabase } from "./archive_database.mjs";
import { completeUploadedRecording } from "./pipeline_archive_journal.mjs";
import { writeJsonFileAtomic } from "./pipeline_file_io.mjs";

const withArchive = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-archive-commit-"));
  try {
    const archivePath = path.join(directory, "vods.json");
    const statePath = path.join(directory, "state.json");
    const original = { id: "old-vod", youtube: [{ id: "existing-video", type: "vod", part: 1 }] };
    const uploadedPart = { id: "uploaded-video", type: "vod", part: 2 };
    const pending = { ...original, youtube: [...original.youtube, uploadedPart] };
    await writeJsonFileAtomic(archivePath, [original], { durable: true });
    const store = createArchiveSnapshotStore(archivePath);
    const vods = await store.read();
    const state = { processedFiles: { recording: {
      status: "uploaded", youtubeVideoId: uploadedPart.id, pendingVodEntry: pending,
    } } };
    const persistState = () => writeJsonFileAtomic(statePath, state, { durable: true });
    await persistState();
    const complete = () => completeUploadedRecording({
      state, recordingPath: "recording", vodEntry: pending, vods,
      persistVods: (rows) => store.write(rows), persistState,
    });
    await run({ archivePath, statePath, state, original, pending, uploadedPart, complete });
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("pipeline-archive-commit-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
};

test("a concurrent archive deletion cannot clear the durable recovery checkpoint for an omitted upload", async () => {
  await withArchive(async ({ archivePath, statePath, state, complete }) => {
    // The finalizer has read its current VOD. An admin removes that VOD before
    // the final archive transaction; the three-way store preserves that deletion.
    await updateArchiveDatabase(archivePath, () => []);
    await assert.rejects(complete());

    assert.deepEqual(await readArchiveDatabase(archivePath), []);
    const durableState = JSON.parse(await fs.readFile(statePath, "utf8"));
    for (const checkpoint of [state.processedFiles.recording, durableState.processedFiles.recording]) {
      assert.equal(checkpoint.status, "uploaded");
      assert.equal(checkpoint.youtubeVideoId, "uploaded-video");
      assert.equal(checkpoint.pendingVodEntry.youtube.at(-1).id, "uploaded-video");
    }
  });
});

test("completion accepts an uploaded video under its current durable owner without resurrecting the old VOD", async () => {
  await withArchive(async ({ archivePath, statePath, uploadedPart, complete }) => {
    // A concurrent admin reconciliation can give the part a different owner.
    // Completion cares that its remote ID is durable, not which VOD owns it.
    const currentOwner = { id: "current-vod", title: "Admin title", youtube: [{ ...uploadedPart, part: 1 }] };
    await updateArchiveDatabase(archivePath, () => [currentOwner]);
    await complete();

    assert.deepEqual(await readArchiveDatabase(archivePath), [currentOwner]);
    const durableState = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(durableState.processedFiles.recording.status, "completed");
    assert.equal(durableState.processedFiles.recording.pendingVodEntry, undefined);
  });
});
