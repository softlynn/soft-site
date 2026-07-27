import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureSoftuchiveStateFiles,
  readSoftuchiveControl,
  readSoftuchiveSettings,
  writeSoftuchiveControl,
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
