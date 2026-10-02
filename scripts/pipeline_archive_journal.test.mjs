import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArchiveSnapshotStore, readArchiveDatabase, updateArchiveDatabase } from "./archive_database.mjs";
import * as journal from "./pipeline_archive_journal.mjs";
const { makeUploadedCheckpoint, recoverUploadedRecordings, completeUploadedRecording } = journal;

const file = { path: "/recordings/stream.mkv", size: 50, modifiedAtMs: 10, durationSeconds: 3600 };
const vod = { id: "twitch-1", title: "Stream", youtube: [], duration: "01:00:00" };
const checkpoint = () => makeUploadedCheckpoint({ recording: file, vodEntry: vod, youtubeVideoId: "youtube-1", partNumber: 1 });

test("upload checkpoints contain everything needed to preserve a returned video without the source", () => {
  const saved = checkpoint();
  assert.equal(saved.status, "uploaded");
  assert.equal(saved.youtubeVideoId, "youtube-1");
  assert.deepEqual(saved.source, { size: 50, modifiedAtMs: 10 });
  assert.equal(saved.pendingVodEntry.youtube[0].duration, 3600);
  vod.title = "Edited later";
  assert.equal(saved.pendingVodEntry.title, "Stream");
  vod.title = "Stream";
});

test("restarting after a remote upload recovers the part and saves the index before completion", async () => {
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const vods = [];
  let storedVods;
  let storedState;
  await recoverUploadedRecordings({
    state, vods,
    finalizeUpload: async (entry) => { assert.equal(entry.youtubeVideoId, "youtube-1"); },
    persistVods: async (next) => {
      assert.equal(state.processedFiles[file.path].status, "uploaded");
      storedVods = structuredClone(next);
      return storedVods;
    },
    persistState: async () => { storedState = structuredClone(state); },
  });
  assert.equal(storedVods[0].youtube[0].id, "youtube-1");
  assert.equal(storedState.processedFiles[file.path].status, "completed");
  assert.equal(storedState.processedFiles[file.path].pendingVodEntry, undefined);
});

test("an index write failure leaves the uploaded checkpoint available for the next run", async () => {
  const state = { processedFiles: { [file.path]: checkpoint() } };
  await assert.rejects(recoverUploadedRecordings({
    state, vods: [], persistVods: async () => { throw new Error("disk unavailable"); }, persistState: async () => {},
  }), /disk unavailable/);
  assert.equal(state.processedFiles[file.path].status, "uploaded");
  assert.equal(state.processedFiles[file.path].pendingVodEntry.youtube[0].id, "youtube-1");
});

test("a completion state write failure retains replay evidence through later error persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-completion-retry-"));
  const statePath = path.join(dir, "state.json");
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const uploaded = structuredClone(state.processedFiles[file.path]);
  const vods = [];
  let durableVods;
  try {
    await assert.rejects(recoverUploadedRecordings({ state, vods,
      persistVods: async (rows) => { durableVods = structuredClone(rows); return durableVods; },
      persistState: async () => { throw Object.assign(new Error("fixture state disk failure"), { code: "EIO" }); },
    }), { code: "EIO" });
    assert.deepEqual(state.processedFiles[file.path], uploaded);
    // The outer run's failure handler persists the still-recoverable state.
    state.processedFiles[file.path].error = "fixture state disk failure";
    await fs.writeFile(statePath, JSON.stringify(state));
    const restarted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(await recoverUploadedRecordings({ state: restarted, vods: durableVods,
      persistVods: async (rows) => rows, persistState: async () => { await fs.writeFile(statePath, JSON.stringify(restarted)); },
    }), 1);
    assert.equal(durableVods[0].youtube.length, 1);
    const completed = JSON.parse(await fs.readFile(statePath, "utf8")).processedFiles[file.path];
    assert.equal(completed.status, "completed");
    assert.equal(completed.pendingVodEntry, undefined);
    assert.equal(completed.error, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a successful archive merge that omits the uploaded ID must retain its recovery checkpoint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-completion-merge-"));
  const archivePath = path.join(dir, "vods.json");
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const originalCheckpoint = structuredClone(state.processedFiles[file.path]);
  try {
    await fs.writeFile(archivePath, JSON.stringify([{ ...vod, youtube: [{ id: "older-part" }] }]));
    const store = createArchiveSnapshotStore(archivePath);
    const vods = await store.read();
    await updateArchiveDatabase(archivePath, () => []);
    await assert.rejects(completeUploadedRecording({ state, recordingPath: file.path,
      vodEntry: state.processedFiles[file.path].pendingVodEntry, vods,
      persistVods: (rows) => store.write(rows), persistState: async () => assert.fail("unindexed video cannot complete"),
    }), { code: "ARCHIVE_UPLOAD_NOT_INDEXED" });
    assert.deepEqual(await readArchiveDatabase(archivePath), []);
    assert.deepEqual(state.processedFiles[file.path], originalCheckpoint);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("completion requires the actual persistence result instead of assuming the submitted snapshot was saved", async () => {
  const state = { processedFiles: { [file.path]: checkpoint() } };
  await assert.rejects(completeUploadedRecording({ state, recordingPath: file.path,
    vodEntry: state.processedFiles[file.path].pendingVodEntry, vods: [],
    persistVods: async () => {}, persistState: async () => assert.fail("unverified write cannot complete"),
  }), /must return the saved VOD array/);
  assert.equal(state.processedFiles[file.path].status, "uploaded");
  assert.equal(state.processedFiles[file.path].pendingVodEntry.youtube[0].id, "youtube-1");
});

test("replay after index save is idempotent and retains other archived parts", async () => {
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const vods = [{ ...vod, youtube: [{ id: "youtube-1", part: 1, type: "vod" }, { id: "youtube-2", part: 2, type: "vod" }] }];
  await recoverUploadedRecordings({ state, vods, persistVods: async (rows) => rows, persistState: async () => {} });
  assert.deepEqual(vods[0].youtube.map(({ id }) => id), ["youtube-1", "youtube-2"]);
});

test("a later part failure cannot erase an already persisted completed part", async () => {
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const vods = [];
  let durableVods;
  await completeUploadedRecording({
    state, recordingPath: file.path, vodEntry: state.processedFiles[file.path].pendingVodEntry, vods,
    persistVods: async (next) => { durableVods = structuredClone(next); return durableVods; }, persistState: async () => {},
  });
  const secondPath = "/recordings/part2.mkv";
  state.processedFiles[secondPath] = makeUploadedCheckpoint({ recording: { ...file, path: secondPath }, vodEntry: vods[0], youtubeVideoId: "youtube-2", partNumber: 2 });
  await assert.rejects(recoverUploadedRecordings({ state, vods, finalizeUpload: async () => { throw new Error("metadata unavailable"); }, persistVods: async () => {}, persistState: async () => {} }), /metadata unavailable/);
  assert.equal(durableVods[0].youtube[0].id, "youtube-1");
  assert.equal(state.processedFiles[file.path].status, "completed");
  assert.equal(state.processedFiles[secondPath].status, "uploaded");
});

const recoverWithPublication = async ({ latest, onDetails, onPrivacy, onMetadata, storedVods = [] } = {}) => {
  assert.equal(typeof journal.finalizeRecoveredUpload, "function", "publication recovery policy is missing");
  const state = { processedFiles: { [file.path]: checkpoint() } };
  const privacyCalls = [];
  const metadataCalls = [];
  const detailsCalls = [];
  let durableVods;
  const run = () => recoverUploadedRecordings({ state, vods: storedVods,
    finalizeUpload: (entry) => journal.finalizeRecoveredUpload({
      checkpoint: entry, readLatestVods: async () => structuredClone(latest()), configuredPrivacy: "public",
      fetchDetails: async (id) => { detailsCalls.push(id); await onDetails?.(); return { durationSeconds: 4000, thumbnailUrl: "remote-thumbnail" }; },
      setPrivacy: async (id, privacy) => { privacyCalls.push([id, privacy]); return onPrivacy ? onPrivacy(id, privacy) : true; },
      syncMetadata: async (entry) => { metadataCalls.push(structuredClone(entry)); await onMetadata?.(); },
    }),
    persistVods: async (rows) => { durableVods = structuredClone(rows); return durableVods; }, persistState: async () => {},
  });
  return { run, state, storedVods, privacyCalls, metadataCalls, detailsCalls, get durableVods() { return durableVods; } };
};

test("recovery preserves an already indexed private part and current admin metadata", async () => {
  const latest = [{ ...vod, title: "Admin title", notes: "retain", youtube: [{ id: "youtube-1", part: 7, type: "vod", unpublished: true, thumbnail_url: "admin-thumbnail", duration: 4100 }] }];
  const fixture = await recoverWithPublication({ latest: () => latest, storedVods: [{ ...vod, youtube: [] }] });
  await fixture.run();
  assert.deepEqual(fixture.privacyCalls, [], "recovery republished a part already controlled by admin");
  assert.deepEqual(fixture.metadataCalls, []);
  assert.deepEqual(fixture.detailsCalls, []);
  assert.deepEqual(fixture.durableVods, latest);
  assert.equal(fixture.state.processedFiles[file.path].status, "completed");
});

test("recovery locates an existing ID under its current merged parent instead of recreating its former VOD", async () => {
  const latest = [{ id: "canonical-parent", title: "Merged title", unpublished: true, youtube: [{ id: "youtube-1", unpublished: true, part: 4 }, { id: "other-video", part: 5 }] }];
  const fixture = await recoverWithPublication({ latest: () => latest, storedVods: [{ ...vod, youtube: [] }] });
  await fixture.run();
  assert.deepEqual(fixture.durableVods, latest);
  assert.deepEqual(fixture.privacyCalls, []);
});

test("a newly recovered part inherits its current unpublished parent and stays private", async () => {
  const latest = [{ ...vod, title: "Admin hidden title", unpublished: true, youtube: [{ id: "retained", part: 2, unpublished: true }] }];
  const fixture = await recoverWithPublication({ latest: () => latest });
  await fixture.run();
  assert.deepEqual(fixture.privacyCalls, [["youtube-1", "private"]]);
  const recovered = fixture.durableVods[0].youtube.find((part) => part.id === "youtube-1");
  assert.equal(recovered.unpublished, true);
  assert.equal(recovered.duration, 4000);
  assert.equal(fixture.durableVods[0].unpublished, true);
  assert.equal(fixture.durableVods[0].title, "Admin hidden title");
});

test("new visible parts use configured publication only after a successful privacy change", async () => {
  const fixture = await recoverWithPublication({ latest: () => [], onPrivacy: async () => false });
  await assert.rejects(fixture.run(), /finalization|privacy/i);
  assert.deepEqual(fixture.privacyCalls, [["youtube-1", "public"]]);
  assert.equal(fixture.durableVods, undefined);
  assert.equal(fixture.state.processedFiles[file.path].status, "uploaded");
});

test("admin changes during finalization are reread and newly hidden recovered media is made private", async () => {
  let latest = [{ ...vod, youtube: [] }];
  const fixture = await recoverWithPublication({ latest: () => latest, onMetadata: async () => {
    latest = [{ ...vod, title: "Changed during callback", unpublished: true, youtube: [{ id: "concurrent", part: 2, unpublished: true }] }, { id: "new-vod", youtube: [] }];
  } });
  await fixture.run();
  assert.deepEqual(fixture.privacyCalls, [["youtube-1", "public"], ["youtube-1", "private"]]);
  const recoveredVod = fixture.durableVods.find((entry) => entry.id === vod.id);
  assert.equal(recoveredVod.title, "Changed during callback");
  assert.equal(recoveredVod.unpublished, true);
  assert.equal(recoveredVod.youtube.find((part) => part.id === "youtube-1").unpublished, true);
  assert.ok(recoveredVod.youtube.some((part) => part.id === "concurrent"));
  assert.ok(fixture.durableVods.some((entry) => entry.id === "new-vod"));
});

test("latest archive state is consulted immediately before privacy and checkpoint siblings stay deleted", async () => {
  let latest = [{ ...vod, youtube: [] }];
  const fixture = await recoverWithPublication({ latest: () => latest, onDetails: async () => {
    latest = [{ ...vod, unpublished: true, youtube: [] }];
  } });
  fixture.state.processedFiles[file.path].pendingVodEntry.youtube.push({ id: "deleted-sibling", part: 9 });
  await fixture.run();
  assert.deepEqual(fixture.privacyCalls, [["youtube-1", "private"]]);
  assert.deepEqual(fixture.durableVods[0].youtube.map((part) => part.id), ["youtube-1"]);
});

test("recovery replaces a stale registered snapshot without undoing later admin database edits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-recovery-privacy-"));
  const archivePath = path.join(dir, "vods.json");
  const store = createArchiveSnapshotStore(archivePath);
  const state = { processedFiles: { [file.path]: checkpoint() } };
  try {
    await fs.writeFile(archivePath, JSON.stringify([{ ...vod, youtube: [{ id: "youtube-1", part: 1 }] }]));
    const stale = await store.read();
    await updateArchiveDatabase(archivePath, () => [{ ...vod, title: "Admin title", unpublished: true,
      youtube: [{ id: "youtube-1", part: 3, unpublished: true, note: "keep" }] }, { id: "concurrent-vod", youtube: [] }]);
    await recoverUploadedRecordings({ state, vods: stale,
      finalizeUpload: (entry) => journal.finalizeRecoveredUpload({ checkpoint: entry, readLatestVods: () => store.read(), configuredPrivacy: "public",
        fetchDetails: async () => assert.fail("indexed upload should retain metadata"), setPrivacy: async () => assert.fail("indexed upload should retain privacy"),
        syncMetadata: async () => assert.fail("indexed upload should retain metadata"), }),
      persistVods: async (rows) => {
        await updateArchiveDatabase(archivePath, (latest) => latest.map((entry) => entry.id === vod.id ? { ...entry, adminNote: "edited after finalization" } : entry));
        return store.write(rows);
      }, persistState: async () => {},
    });
    const saved = await readArchiveDatabase(archivePath);
    assert.equal(saved[0].title, "Admin title");
    assert.equal(saved[0].unpublished, true);
    assert.equal(saved[0].adminNote, "edited after finalization");
    assert.deepEqual(saved[0].youtube, [{ id: "youtube-1", part: 3, unpublished: true, note: "keep" }]);
    assert.equal(saved[1].id, "concurrent-vod");
    assert.equal(state.processedFiles[file.path].status, "completed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("invalid current archive data leaves recovery pending without remote mutations", async () => {
  const fixture = await recoverWithPublication({ latest: () => ({ corrupt: true }) });
  await assert.rejects(fixture.run(), /JSON array/);
  assert.deepEqual(fixture.privacyCalls, []);
  assert.equal(fixture.durableVods, undefined);
  assert.equal(fixture.state.processedFiles[file.path].status, "uploaded");
});

test("a new visible upload completes with configured privacy and refreshed remote details", async () => {
  const fixture = await recoverWithPublication({ latest: () => [] });
  await fixture.run();
  assert.deepEqual(fixture.privacyCalls, [["youtube-1", "public"]]);
  assert.equal(fixture.durableVods[0].youtube[0].duration, 4000);
  assert.equal(fixture.durableVods[0].youtube[0].thumbnail_url, "remote-thumbnail");
  assert.equal(fixture.durableVods[0].youtube[0].unpublished, undefined);
  assert.equal(fixture.state.processedFiles[file.path].status, "completed");
});

test("normal upload finalization preserves a parent hidden during upload and returns the fresh saved entry", async () => {
  assert.equal(typeof journal.finalizeAndCompleteUploadedRecording, "function", "normal finalization must use the current archive policy");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-normal-finalize-"));
  const archivePath = path.join(dir, "vods.json");
  const store = createArchiveSnapshotStore(archivePath);
  const state = { processedFiles: { [file.path]: checkpoint() } };
  try {
    await fs.writeFile(archivePath, JSON.stringify([{ ...vod, youtube: [] }]));
    const stale = await store.read();
    await updateArchiveDatabase(archivePath, () => [{ ...vod, title: "Admin current title", unpublished: true,
      youtube: [{ id: "existing-part", part: 3, unpublished: true, type: "vod" }] }, { id: "other-vod", youtube: [] }]);
    const privacyCalls = [];
    let metadata;
    const current = await journal.finalizeAndCompleteUploadedRecording({
      state, recordingPath: file.path, vods: stale,
      readLatestVods: () => store.read(), configuredPrivacy: "public",
      fetchDetails: async () => ({ durationSeconds: 3601, thumbnailUrl: "new-thumbnail" }),
      setPrivacy: async (id, value) => { privacyCalls.push([id, value]); return true; },
      syncMetadata: async (entry) => { metadata = structuredClone(entry); },
      persistVods: (rows) => store.write(rows), persistState: async () => {},
    });
    const saved = await readArchiveDatabase(archivePath);
    assert.deepEqual(privacyCalls, [["youtube-1", "private"]]);
    assert.equal(current, stale.find((entry) => entry.id === "twitch-1"), "caller retained a detached stale VOD reference");
    assert.equal(current.title, "Admin current title");
    assert.equal(metadata.title, "Admin current title");
    assert.equal(saved[0].unpublished, true);
    assert.equal(saved[0].youtube.find((part) => part.id === "youtube-1").unpublished, true);
    assert.ok(saved[0].youtube.some((part) => part.id === "existing-part"));
    assert.ok(saved.some((entry) => entry.id === "other-vod"));
    assert.equal(state.processedFiles[file.path].status, "completed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("normal finalization leaves the returned upload checkpoint pending if privacy fails", async () => {
  assert.equal(typeof journal.finalizeAndCompleteUploadedRecording, "function");
  const state = { processedFiles: { [file.path]: checkpoint() } };
  await assert.rejects(journal.finalizeAndCompleteUploadedRecording({
    state, recordingPath: file.path, vods: [], readLatestVods: async () => [], configuredPrivacy: "public",
    fetchDetails: async () => ({ durationSeconds: 3600 }), setPrivacy: async () => false,
    syncMetadata: async () => assert.fail("metadata must wait for privacy"),
    persistVods: async () => assert.fail("failed finalization cannot reach the index"), persistState: async () => {},
  }), /privacy finalization/);
  assert.equal(state.processedFiles[file.path].status, "uploaded");
  assert.equal(state.processedFiles[file.path].youtubeVideoId, "youtube-1");
});

test("an acknowledged unavailable video retains its checkpoint while a later upload completes", async () => {
  const secondPath = "/recordings/second.mkv";
  const state = { processedFiles: {
    [file.path]: checkpoint(),
    [secondPath]: makeUploadedCheckpoint({ recording: { ...file, path: secondPath }, vodEntry: vod, youtubeVideoId: "youtube-2", partNumber: 2 }),
  } };
  const retained = structuredClone(state.processedFiles[file.path]);
  const vods = [];
  const failures = [];
  const recovered = await recoverUploadedRecordings({ state, vods,
    finalizeUpload: (entry) => journal.finalizeRecoveredUpload({ checkpoint: entry,
      readLatestVods: async () => structuredClone(vods), fetchDetails: async () => ({ durationSeconds: 3600 }),
      setPrivacy: async (id) => id !== "youtube-1", syncMetadata: async () => {},
    }),
    persistVods: async (rows) => structuredClone(rows), persistState: async () => {},
    onRecoveryError: async (error, entry, recordingPath) => {
      failures.push({ code: error.code, videoId: entry.youtubeVideoId, recordingPath });
      return true;
    },
  });
  assert.equal(recovered, 1);
  assert.deepEqual(failures, [{ code: "SOFTUCHIVE_UPLOAD_FINALIZATION_PENDING", videoId: "youtube-1", recordingPath: file.path }]);
  assert.deepEqual(state.processedFiles[file.path], retained);
  assert.equal(state.processedFiles[secondPath].status, "completed");
  assert.deepEqual(vods[0].youtube.map((part) => part.id), ["youtube-2"]);
});

test("recovery never defers storage failures, corrupt data or controls even with an acknowledgement hook", async () => {
  const errors = [
    Object.assign(new Error("disk unavailable"), { code: "EIO" }),
    new SyntaxError("invalid persisted JSON"),
    Object.assign(new Error("paused"), { code: "SOFTUCHIVE_PAUSED" }),
    Object.assign(new Error("skipped"), { code: "SOFTUCHIVE_SKIPPED" }),
    Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }),
    Object.assign(new Error("credentials expired"), { code: 401 }),
  ];
  for (const failure of errors) {
    const state = { processedFiles: { [file.path]: checkpoint() } };
    const retained = structuredClone(state.processedFiles[file.path]);
    await assert.rejects(recoverUploadedRecordings({ state, vods: [],
      finalizeUpload: async () => { throw failure; },
      persistVods: async () => assert.fail("failed finalization cannot persist"), persistState: async () => {},
      onRecoveryError: async () => assert.fail("unsafe errors must never reach the deferral callback"),
    }), error => error === failure);
    assert.deepEqual(state.processedFiles[file.path], retained);
  }
  for (const stage of ["archive", "state"]) {
    const state = { processedFiles: { [file.path]: checkpoint() } };
    const retained = structuredClone(state.processedFiles[file.path]);
    const failure = Object.assign(new Error("disk unavailable"), { code: "EIO" });
    await assert.rejects(recoverUploadedRecordings({ state, vods: [],
      persistVods: async (rows) => { if (stage === "archive") throw failure; return rows; },
      persistState: async () => { throw failure; },
      onRecoveryError: async () => assert.fail("persistence errors cannot be deferred"),
    }), error => error === failure);
    assert.deepEqual(state.processedFiles[file.path], retained);
  }
});

test("unavailable recovery requires explicit acknowledgement and callback failures propagate", async () => {
  const unavailable = Object.assign(new Error("video unavailable"), { code: "SOFTUCHIVE_UPLOAD_FINALIZATION_PENDING" });
  const callbackFailure = new Error("unable to record pending recovery");
  for (const [onRecoveryError, expected] of [
    [undefined, unavailable], [async () => false, unavailable], [async () => {}, unavailable],
    [async () => { throw callbackFailure; }, callbackFailure],
  ]) {
    const state = { processedFiles: { [file.path]: checkpoint() } };
    const retained = structuredClone(state.processedFiles[file.path]);
    await assert.rejects(recoverUploadedRecordings({ state, vods: [],
      finalizeUpload: async () => { throw unavailable; },
      persistVods: async () => assert.fail("unavailable recovery cannot persist"), persistState: async () => {}, onRecoveryError,
    }), error => error === expected);
    assert.deepEqual(state.processedFiles[file.path], retained);
  }
});
