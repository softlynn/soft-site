import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ensureSoftuchiveStateFiles,
  readSoftuchiveControl,
  readSoftuchiveSettings,
  readSoftuchiveRuntime,
  resolveSoftuchivePaths,
  writeSoftuchiveControl,
  writeSoftuchiveRuntime,
  writeSoftuchiveSettings,
} from "./softuchive_state.mjs";

const withTempRepo = async (run) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-state-"));
  try {
    await run(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
};

test("creates state files with an absolute archive folder", async () => {
  await withTempRepo(async (repoRoot) => {
    const archiveFolder = path.join(repoRoot, "recordings");
    const result = await ensureSoftuchiveStateFiles(repoRoot, { archiveFolder });

    assert.equal(result.settings.archiveFolder, archiveFolder);
    assert.equal(result.settings.pollingIntervalMinutes, 15);
    assert.equal(result.runtime.run.status, "idle");
    assert.equal(result.control.pauseRequested, false);
  });
});

test("concurrent control patches preserve pause, throttle, and skip requests", async () => {
  await withTempRepo(async (repoRoot) => {
    await ensureSoftuchiveStateFiles(repoRoot);
    await Promise.all([
      writeSoftuchiveControl(repoRoot, { uploadPaused: true }),
      writeSoftuchiveControl(repoRoot, { uploadThrottleMbps: 3 }),
      writeSoftuchiveControl(repoRoot, { skipRequestedUploadSessionId: "part-7" }),
    ]);
    const control = await readSoftuchiveControl(repoRoot);
    assert.equal(control.uploadPaused, true);
    assert.equal(control.uploadThrottleMbps, 3);
    assert.equal(control.skipRequestedUploadSessionId, "part-7");
  });
});

test("concurrent runtime patches retain stage and queue updates", async () => {
  await withTempRepo(async (repoRoot) => {
    await ensureSoftuchiveStateFiles(repoRoot);
    await Promise.all([
      writeSoftuchiveRuntime(repoRoot, { run: { stage: "uploading" } }),
      writeSoftuchiveRuntime(repoRoot, { run: { queue: { remaining: 2 } } }),
    ]);
    const runtime = await readSoftuchiveRuntime(repoRoot);
    assert.equal(runtime.run.stage, "uploading");
    assert.equal(runtime.run.queue.remaining, 2);
  });
});

test("readers always see complete JSON while settings are replaced", async () => {
  await withTempRepo(async (repoRoot) => {
    await ensureSoftuchiveStateFiles(repoRoot);
    const { settingsPath } = resolveSoftuchivePaths(repoRoot);
    let finished = false;
    const writer = (async () => {
      for (let index = 0; index < 12; index++) {
        await writeSoftuchiveSettings(repoRoot, { note: "x".repeat(256 * 1024), index });
      }
    })().finally(() => { finished = true; });
    void writer.catch(() => {});
    let readError;
    // A bounded read burst also gives Windows a quiet window to release sharing locks.
    const readUntil = Date.now() + 100;
    while (!finished && Date.now() < readUntil) {
      try {
        JSON.parse(await fs.readFile(settingsPath, "utf8"));
      } catch (error) {
        readError ||= error;
      }
      await delay(10);
    }
    await writer;
    assert.equal(readError, undefined, "a reader observed partially written settings JSON");
    assert.equal((await readSoftuchiveSettings(repoRoot)).index, 11);
  });
});

test("normalizes settings and upload controls", async () => {
  await withTempRepo(async (repoRoot) => {
    const archiveFolder = path.join(repoRoot, "archive");
    await ensureSoftuchiveStateFiles(repoRoot, { archiveFolder });

    await writeSoftuchiveSettings(
      repoRoot,
      {
        pollingIntervalMinutes: 30,
        pollOnObsCloseEnabled: true,
        archiveFolder,
      },
      { archiveFolder }
    );
    const settings = await readSoftuchiveSettings(repoRoot, { archiveFolder });
    assert.equal(settings.pollingIntervalMinutes, 30);
    assert.equal(settings.pollOnObsCloseEnabled, true);

    await writeSoftuchiveControl(repoRoot, {
      uploadThrottleMbps: 6.257,
      skipRequestedUploadSessionId: "upload-1",
      skipRequestedAt: "2026-01-01T00:00:00.000Z",
    });
    let control = await readSoftuchiveControl(repoRoot);
    assert.equal(control.uploadThrottleMbps, 6.26);
    assert.equal(control.skipRequestedUploadSessionId, "upload-1");

    await writeSoftuchiveControl(repoRoot, {
      uploadThrottleMbps: -10,
      skipRequestedUploadSessionId: "",
    });
    control = await readSoftuchiveControl(repoRoot);
    assert.equal(control.uploadThrottleMbps, null);
    assert.equal(control.skipRequestedUploadSessionId, "");
    assert.equal(control.skipRequestedAt, null);
  });
});
