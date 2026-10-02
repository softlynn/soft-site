import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireArchiveFileLock } from "./archive_database.mjs";
import { writeJsonFileAtomic } from "./pipeline_file_io.mjs";

import {
  ensureSoftuchiveStateFiles,
  clearSoftuchiveSkipRequest,
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

test("state corruption is actionable, preserves the original file, and never echoes its contents", async () => {
  await withTempRepo(async (repoRoot) => {
    const { settingsPath, runtimePath, controlPath } = resolveSoftuchivePaths(repoRoot);
    await fs.mkdir(path.dirname(controlPath), { recursive: true });
    const malformed = '{"credential": "secret-sentinel-123", broken';
    for (const [filePath, read, write] of [
      [settingsPath, readSoftuchiveSettings, writeSoftuchiveSettings],
      [runtimePath, readSoftuchiveRuntime, writeSoftuchiveRuntime],
      [controlPath, readSoftuchiveControl, writeSoftuchiveControl],
    ]) {
      await fs.writeFile(filePath, malformed);
      for (const operation of [() => read(repoRoot), () => write(repoRoot, {})]) {
        await assert.rejects(operation, (error) => {
          assert.equal(error.code, "SOFTUCHIVE_STATE_INVALID");
          assert.match(error.message, /Repair or restore/);
          assert.ok(error.message.includes(path.basename(filePath)));
          assert.ok(!String(error.stack).includes("secret-sentinel-123"));
          assert.equal(error.cause, undefined);
          return true;
        });
      }
      assert.equal(await fs.readFile(filePath, "utf8"), malformed);
      await fs.unlink(filePath);
    }
  });
});

test("missing state uses defaults while non-object state is rejected", async () => {
  await withTempRepo(async (repoRoot) => {
    assert.equal((await readSoftuchiveControl(repoRoot)).pauseRequested, false);
    const { controlPath } = resolveSoftuchivePaths(repoRoot);
    await fs.mkdir(path.dirname(controlPath), { recursive: true });
    for (const value of [null, [], "paused", false, 15]) {
      await fs.writeFile(controlPath, JSON.stringify(value));
      await assert.rejects(() => readSoftuchiveControl(repoRoot), { code: "SOFTUCHIVE_STATE_INVALID" });
    }
    await fs.writeFile(controlPath, '\uFEFF{"pauseRequested": true}');
    assert.equal((await readSoftuchiveControl(repoRoot)).pauseRequested, true);
  });
});

test("oversized reads and writes fail before overwriting usable state", async () => {
  await withTempRepo(async (repoRoot) => {
    await ensureSoftuchiveStateFiles(repoRoot);
    const { runtimePath } = resolveSoftuchivePaths(repoRoot);
    const previous = await fs.readFile(runtimePath, "utf8");
    await assert.rejects(() => writeSoftuchiveRuntime(repoRoot, { note: "x".repeat(8 * 1024 * 1024) }), {
      code: "SOFTUCHIVE_STATE_TOO_LARGE",
    });
    assert.equal(await fs.readFile(runtimePath, "utf8"), previous);
    const handle = await fs.open(runtimePath, "r+");
    try { await handle.truncate(8 * 1024 * 1024 + 1); }
    finally { await handle.close(); }
    await assert.rejects(() => readSoftuchiveRuntime(repoRoot), { code: "SOFTUCHIVE_STATE_TOO_LARGE" });
  });
});

test("filesystem read failures do not appear as an idle run", async () => {
  await withTempRepo(async (repoRoot) => {
    const { runtimePath } = resolveSoftuchivePaths(repoRoot);
    await fs.mkdir(runtimePath, { recursive: true });
    await assert.rejects(() => readSoftuchiveRuntime(repoRoot), (error) => {
      assert.match(error.code, /^SOFTUCHIVE_STATE_(INVALID|READ_FAILED)$/);
      assert.ok(error.message.includes("softuchive-runtime.json"));
      return true;
    });
  });
});

test("runtime progress is normalized without losing paused resume data or unknown fields", async () => {
  await withTempRepo(async (repoRoot) => {
    const resumed = {
      sessionId: "resume-1", state: "paused", percent: null, uploadedBytes: "4096", totalBytes: "8192",
      estimatedRemainingMs: null, uploadMbps: "Infinity", resumeOffset: 4096,
      recordingPath: path.join(repoRoot, "recording.mp4"),
    };
    const written = await writeSoftuchiveRuntime(repoRoot, {
      run: {
        active: false, status: "paused", current: resumed,
        queue: { total: "3", remaining: -2, remainingBytes: "8192", totalBytes: "Infinity", estimatedRemainingMs: null },
        uploads: [null, resumed, "bad", [], { sessionId: "other", percent: 120, uploadedBytes: 150, totalBytes: 100 }],
      },
      events: [null, "bad", ...Array.from({ length: 130 }, (_, index) => ({ message: `Event ${index}` }))],
    });
    const runtime = await readSoftuchiveRuntime(repoRoot);
    assert.deepEqual(runtime, written);
    assert.equal(runtime.run.current.percent, null);
    assert.equal(runtime.run.current.uploadedBytes, 4096);
    assert.equal(runtime.run.current.estimatedRemainingMs, null);
    assert.equal(runtime.run.current.uploadMbps, null);
    assert.equal(runtime.run.current.resumeOffset, 4096);
    assert.equal(runtime.run.current.recordingPath, resumed.recordingPath);
    assert.equal(runtime.run.status, "paused");
    assert.equal(runtime.run.queue.total, 3);
    assert.equal(runtime.run.queue.remaining, 0);
    assert.equal(runtime.run.queue.totalBytes, 0);
    assert.equal(runtime.run.queue.estimatedRemainingMs, null);
    assert.equal(runtime.run.uploads.length, 2);
    assert.equal(runtime.run.uploads[1].percent, 100);
    assert.equal(runtime.run.uploads[1].uploadedBytes, 100);
    assert.equal(runtime.events.length, 120);
    assert.equal(runtime.events[0].message, "Event 10");
    const cleared = await writeSoftuchiveRuntime(repoRoot, { run: { current: null, uploads: [] } });
    assert.equal(cleared.run.current, null);
    assert.deepEqual(cleared.run.uploads, []);
  });
});

test("malformed nested runtime objects cannot become numeric object properties", async () => {
  await withTempRepo(async (repoRoot) => {
    const { runtimePath } = resolveSoftuchivePaths(repoRoot);
    await fs.mkdir(path.dirname(runtimePath), { recursive: true });
    await fs.writeFile(runtimePath, JSON.stringify({ app: ["bad"], run: { active: "true", queue: [12], current: ["bad"], uploads: {} }, events: {} }));
    const runtime = await readSoftuchiveRuntime(repoRoot);
    assert.equal(runtime.run.active, false);
    assert.equal(runtime.run.current, null);
    assert.deepEqual(runtime.run.uploads, []);
    assert.deepEqual(runtime.events, []);
    assert.equal(Object.hasOwn(runtime.app, "0"), false);
    assert.equal(Object.hasOwn(runtime.run.queue, "0"), false);
  });
});

test("poll settings are bounded consistently and valid preferences survive partial edits", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeSoftuchiveSettings(repoRoot, { pollingIntervalMinutes: 37, pollOnObsCloseEnabled: true });
    const first = await writeSoftuchiveSettings(repoRoot, { note: "preserve preferences" });
    assert.equal(first.pollingIntervalMinutes, 37);
    assert.equal(first.pollOnObsCloseEnabled, true);
    for (const [input, expected] of [["720.9", 720], [-5, 1], ["not-a-number", 15]]) {
      assert.equal((await writeSoftuchiveSettings(repoRoot, { pollingIntervalMinutes: input })).pollingIntervalMinutes, expected);
      assert.equal((await readSoftuchiveSettings(repoRoot)).pollingIntervalMinutes, expected);
    }
  });
});

test("malformed control types cannot silently unpause or disable a limit", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeSoftuchiveControl(repoRoot, { pauseRequested: true, uploadThrottleMbps: 5 });
    const { controlPath } = resolveSoftuchivePaths(repoRoot);
    const original = await fs.readFile(controlPath, "utf8");
    for (const patch of [
      { pauseRequested: "false" }, { uploadPaused: null }, { uploadThrottleMbps: true },
      { uploadThrottleMbps: "credential-sentinel" }, { uploadThrottleMbps: "Infinity" },
      { skipRequestedUploadSessionId: {} },
    ]) {
      await assert.rejects(() => writeSoftuchiveControl(repoRoot, patch), { code: "SOFTUCHIVE_STATE_INVALID" });
      assert.equal(await fs.readFile(controlPath, "utf8"), original);
      await fs.writeFile(controlPath, JSON.stringify(patch));
      await assert.rejects(() => readSoftuchiveControl(repoRoot), (error) => {
        assert.equal(error.code, "SOFTUCHIVE_STATE_INVALID");
        assert.ok(!String(error.stack).includes("credential-sentinel"));
        return true;
      });
      await fs.writeFile(controlPath, original);
    }
    for (const uploadThrottleMbps of [NaN, Infinity, -Infinity]) {
      await assert.rejects(() => writeSoftuchiveControl(repoRoot, { uploadThrottleMbps }), { code: "SOFTUCHIVE_STATE_INVALID" });
      assert.equal(await fs.readFile(controlPath, "utf8"), original);
    }
    const saved = await readSoftuchiveControl(repoRoot);
    assert.equal(saved.pauseRequested, true);
    assert.equal(saved.uploadThrottleMbps, 5);
  });
});

test("invalid settings cannot redirect the recording folder or disable an enabled preference", async () => {
  await withTempRepo(async (repoRoot) => {
    const archiveFolder = path.join(repoRoot, "custom-recordings");
    await writeSoftuchiveSettings(repoRoot, { archiveFolder, pollOnObsCloseEnabled: true });
    const { settingsPath } = resolveSoftuchivePaths(repoRoot);
    const original = await fs.readFile(settingsPath, "utf8");
    for (const patch of [{ archiveFolder: {} }, { pollOnObsCloseEnabled: "false" }]) {
      await assert.rejects(() => writeSoftuchiveSettings(repoRoot, patch), { code: "SOFTUCHIVE_STATE_INVALID" });
      assert.equal(await fs.readFile(settingsPath, "utf8"), original);
      await fs.writeFile(settingsPath, JSON.stringify(patch));
      await assert.rejects(() => readSoftuchiveSettings(repoRoot), { code: "SOFTUCHIVE_STATE_INVALID" });
      await fs.writeFile(settingsPath, original);
    }
    const saved = await readSoftuchiveSettings(repoRoot);
    assert.equal(saved.archiveFolder, archiveFolder);
    assert.equal(saved.pollOnObsCloseEnabled, true);
  });
});

test("clearing one skip request preserves a newer request and other controls", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeSoftuchiveControl(repoRoot, { pauseRequested: true, uploadThrottleMbps: 5, skipRequestedUploadSessionId: "newer", skipRequestedAt: "2026-01-01T00:00:00Z" });
    const { controlPath } = resolveSoftuchivePaths(repoRoot);
    const original = await fs.readFile(controlPath, "utf8");
    assert.equal((await clearSoftuchiveSkipRequest(repoRoot, "older")).skipRequestedUploadSessionId, "newer");
    assert.equal(await fs.readFile(controlPath, "utf8"), original);
    const cleared = await clearSoftuchiveSkipRequest(repoRoot, "newer");
    assert.equal(cleared.skipRequestedUploadSessionId, "");
    assert.equal(cleared.skipRequestedAt, null);
    assert.equal(cleared.pauseRequested, true);
    assert.equal(cleared.uploadThrottleMbps, 5);
  });
});

test("control writers and skip clearing wait for other processes before reading their latest changes", async (t) => {
  for (const operation of ["patch", "clear"]) {
    await t.test(operation, async () => withTempRepo(async (repoRoot) => {
      await writeSoftuchiveControl(repoRoot, { skipRequestedUploadSessionId: "older" });
      const { controlPath } = resolveSoftuchivePaths(repoRoot);
      const release = await acquireArchiveFileLock(controlPath);
      const script = `
        import { writeSoftuchiveControl, clearSoftuchiveSkipRequest } from ${JSON.stringify(new URL("./softuchive_state.mjs", import.meta.url).href)};
        process.send('attempting');
        if (process.argv[2] === 'patch') await writeSoftuchiveControl(process.argv[1], { uploadThrottleMbps: 7 });
        else await clearSoftuchiveSkipRequest(process.argv[1], 'older');
        process.disconnect();
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, repoRoot, operation], {
        windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let exited = false;
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const completion = once(child, "exit").then(([code]) => { exited = true; return code; });
      try {
        await once(child, "message", { signal: AbortSignal.timeout(5000) });
        await delay(60);
        assert.equal(exited, false, "control mutation bypassed the shared lock");
        const current = await readSoftuchiveControl(repoRoot);
        await writeJsonFileAtomic(controlPath, { ...current, pauseRequested: true, skipRequestedUploadSessionId: "newer" });
        await release();
        assert.equal(await completion, 0, stderr);
        const saved = await readSoftuchiveControl(repoRoot);
        assert.equal(saved.pauseRequested, true);
        assert.equal(saved.skipRequestedUploadSessionId, "newer");
        assert.equal(saved.uploadThrottleMbps, operation === "patch" ? 7 : null);
      } finally {
        await release();
        if (!exited) child.kill();
        await completion;
      }
    }));
  }
});
