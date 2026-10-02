import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createUploadSessionStore } from "./upload_session_store.mjs";

const loadCopyModule = async () => {
  const module = await import("./pipeline_upload_copy.mjs").catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  });
  assert.equal(typeof module.ensureTrack1UploadCopy, "function", "durable remux cache is missing");
  return module;
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.mkv");
  await fs.writeFile(sourcePath, "original audio and video bytes");
  const stat = await fs.stat(sourcePath);
  return { root, cacheRoot: path.join(root, "cache"), source: { path: sourcePath, name: "source.mkv", size: stat.size, modifiedAtMs: stat.mtimeMs } };
}

test("completed remux cache reuses the same bytes and timestamp without another preparation", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  let prepares = 0;
  const prepare = async (partial) => { prepares++; await fs.writeFile(partial, `remux bytes ${prepares}`); };
  const [first, concurrent] = await Promise.all([
    ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare }),
    ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare }),
  ]);
  const resumed = await ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare });
  assert.equal(prepares, 1);
  assert.equal(first.path, concurrent.path);
  assert.equal(resumed.path, first.path);
  assert.equal(resumed.modifiedAtMs, first.modifiedAtMs);
  assert.equal(resumed.cacheReused, true);
  assert.equal(await fs.readFile(first.path, "utf8"), "remux bytes 1");
  const manifest = JSON.parse(await fs.readFile(first.uploadCopyManifestPath, "utf8"));
  assert.equal(manifest.source.path, path.resolve(f.source.path));
  assert.equal(manifest.source.size, f.source.size);
  assert.equal(manifest.source.modifiedAtMs, f.source.modifiedAtMs);
  assert.equal(await fs.readFile(f.source.path, "utf8"), "original audio and video bytes");
});

test("cache names disambiguate identical names and different source versions", async (t) => {
  const { buildTrack1UploadCopyPath } = await loadCopyModule();
  const f = await fixture(t);
  const original = buildTrack1UploadCopyPath(f.source, f.cacheRoot);
  assert.notEqual(buildTrack1UploadCopyPath({ ...f.source, path: path.join(f.root, "elsewhere", "source.mkv") }, f.cacheRoot), original);
  assert.notEqual(buildTrack1UploadCopyPath({ ...f.source, size: f.source.size + 1 }, f.cacheRoot), original);
  assert.notEqual(buildTrack1UploadCopyPath({ ...f.source, modifiedAtMs: f.source.modifiedAtMs + 1 }, f.cacheRoot), original);
  assert.equal(path.dirname(original), path.join(f.cacheRoot, "youtube-upload-audio1"));
});

test("source changes before or during preparation never publish a completed copy", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  let prepares = 0;
  await assert.rejects(ensureTrack1UploadCopy({ ...f.source, size: f.source.size + 1 }, {
    cacheRoot: f.cacheRoot, prepare: async () => { prepares++; },
  }), /source changed/i);
  assert.equal(prepares, 0);
  await assert.rejects(ensureTrack1UploadCopy(f.source, {
    cacheRoot: f.cacheRoot,
    prepare: async (partial) => {
      await fs.writeFile(partial, "incomplete copy");
      await fs.appendFile(f.source.path, "source grew");
    },
  }), /source changed/i);
  assert.deepEqual(await fs.readdir(path.join(f.cacheRoot, "youtube-upload-audio1")), []);
  assert.match(await fs.readFile(f.source.path, "utf8"), /source grew$/);
});

test("failed or empty preparation cannot leave a cache entry and never removes the source", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  await assert.rejects(ensureTrack1UploadCopy(f.source, {
    cacheRoot: f.cacheRoot,
    prepare: async (partial) => { await fs.writeFile(partial, "partial"); throw new Error("ffmpeg failed"); },
  }), /ffmpeg failed/);
  await assert.rejects(ensureTrack1UploadCopy(f.source, {
    cacheRoot: f.cacheRoot, prepare: (partial) => fs.writeFile(partial, ""),
  }), /empty|valid/i);
  assert.deepEqual(await fs.readdir(path.join(f.cacheRoot, "youtube-upload-audio1")), []);
  assert.equal(await fs.readFile(f.source.path, "utf8"), "original audio and video bytes");
});

test("an altered cached copy or missing completion manifest requires fresh preparation", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  let prepares = 0;
  const options = { cacheRoot: f.cacheRoot, prepare: async (partial) => { prepares++; await fs.writeFile(partial, `copy ${prepares}`); } };
  const first = await ensureTrack1UploadCopy(f.source, options);
  await fs.writeFile(first.path, "changed copy");
  const second = await ensureTrack1UploadCopy(f.source, options);
  assert.equal(prepares, 2);
  assert.equal(second.cacheReused, false);
  assert.equal(await fs.readFile(second.path, "utf8"), "copy 2");
  await fs.rm(second.uploadCopyManifestPath);
  await ensureTrack1UploadCopy(f.source, options);
  assert.equal(prepares, 3);
});

test("a malformed completion manifest cannot prevent safe regeneration", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  let prepares = 0;
  const options = { cacheRoot: f.cacheRoot, prepare: async (partial) => { prepares++; await fs.writeFile(partial, "copy"); } };
  const copy = await ensureTrack1UploadCopy(f.source, options);
  await fs.writeFile(copy.uploadCopyManifestPath, JSON.stringify({ version: 1, source: { size: f.source.size }, output: {} }));
  const regenerated = await ensureTrack1UploadCopy(f.source, options);
  assert.equal(prepares, 2);
  assert.equal(regenerated.cacheReused, false);
  await fs.access(f.source.path);
});

for (const missingEvidence of ["missing manifest", "invalid manifest", "changed media", "missing media", "unreadable session"]) {
  test(`${missingEvidence} preserves saved upload evidence instead of regenerating media`, async (t) => {
    const { ensureTrack1UploadCopy } = await loadCopyModule();
    const f = await fixture(t);
    let prepares = 0;
    const options = { cacheRoot: f.cacheRoot, prepare: async (partial) => { prepares++; await fs.writeFile(partial, "exact original remux bytes"); } };
    const copy = await ensureTrack1UploadCopy(f.source, options);
    const sessionDirectory = path.join(f.root, "upload-sessions");
    const store = createUploadSessionStore(sessionDirectory, copy.path);
    await store.save({ version: 1, confirmedBytes: 8, finalAttempted: true });
    if (missingEvidence === "invalid manifest") await fs.writeFile(copy.uploadCopyManifestPath, "{invalid");
    else if (missingEvidence === "changed media") await fs.writeFile(copy.path, "modified evidence");
    else if (missingEvidence === "missing media") await fs.rm(copy.path);
    else await fs.rm(copy.uploadCopyManifestPath);
    if (missingEvidence === "unreadable session") {
      const [sessionName] = await fs.readdir(sessionDirectory);
      await fs.writeFile(path.join(sessionDirectory, sessionName), "{unreadable");
    }
    const priorBytes = await fs.readFile(copy.path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    await assert.rejects(ensureTrack1UploadCopy(f.source, {
      ...options,
      hasUploadSession: async (outputPath) => Boolean(await createUploadSessionStore(sessionDirectory, outputPath).load()),
    }), { code: missingEvidence === "unreadable session" ? "SOFTUCHIVE_UPLOAD_SESSION_UNREADABLE" : "SOFTUCHIVE_UPLOAD_COPY_UNVERIFIED" });
    assert.equal(prepares, 1);
    if (priorBytes) assert.deepEqual(await fs.readFile(copy.path), priorBytes);
    else await assert.rejects(fs.access(copy.path), { code: "ENOENT" });
    assert.equal((await fs.readdir(sessionDirectory)).length, 1);
    await fs.access(f.source.path);
  });
}

test("a failed media flush leaves the prior cached bytes untouched", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "old copy") });
  await fs.rm(copy.uploadCopyManifestPath);
  const originalOpen = fs.open;
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".partial.mkv")) handle.sync = async () => { throw Object.assign(new Error("fixture media flush"), { code: "EIO" }); };
      return handle;
    };
    await assert.rejects(ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "new copy") }), { code: "EIO" });
    assert.equal(await fs.readFile(copy.path, "utf8"), "old copy");
    assert.deepEqual(await fs.readdir(path.dirname(copy.path)), [path.basename(copy.path)]);
  } finally { fs.open = originalOpen; }
});

test("a failed completion-record flush does not report a prepared upload copy", async (t) => {
  const { ensureTrack1UploadCopy, buildTrack1UploadCopyPath } = await loadCopyModule();
  const f = await fixture(t);
  const copyPath = buildTrack1UploadCopyPath(f.source, f.cacheRoot);
  const originalOpen = fs.open;
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(`${copyPath}.json.`) && String(args[0]).endsWith(".tmp")) {
        handle.sync = async () => { throw Object.assign(new Error("fixture completion flush"), { code: "EIO" }); };
      }
      return handle;
    };
    await assert.rejects(ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "flushed media") }), { code: "EIO" });
    assert.equal(await fs.readFile(copyPath, "utf8"), "flushed media");
    await assert.rejects(fs.access(`${copyPath}.json`), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(path.dirname(copyPath)), [path.basename(copyPath)]);
  } finally { fs.open = originalOpen; }
});

test("cleanup removes only stale orphan partials and retains resumable copies and live preparations", async (t) => {
  const { ensureTrack1UploadCopy, cleanupStaleUploadCopyPartials } = await loadCopyModule();
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: (partial) => fs.writeFile(partial, "copy") });
  const stalePartial = `${copy.path}.99999999.1234-abcd.partial.mkv`;
  const staleManifest = `${copy.uploadCopyManifestPath}.99999999.1234-abcd.tmp`;
  const livePartial = `${copy.path}.${process.pid}.1234-abcd.partial.mkv`;
  const freshPartial = `${copy.path}.99999999.5678-abcd.partial.mkv`;
  for (const target of [stalePartial, staleManifest, livePartial, freshPartial]) await fs.writeFile(target, "partial");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const target of [stalePartial, staleManifest, livePartial, copy.path, copy.uploadCopyManifestPath]) await fs.utimes(target, old, old);
  await cleanupStaleUploadCopyPartials(f.cacheRoot);
  await assert.rejects(fs.access(stalePartial), { code: "ENOENT" });
  await assert.rejects(fs.access(staleManifest), { code: "ENOENT" });
  for (const retained of [livePartial, freshPartial, copy.path, copy.uploadCopyManifestPath, f.source.path]) await fs.access(retained);
});

test("terminal cleanup removes generated copy and manifest while refusing source paths", async (t) => {
  const { ensureTrack1UploadCopy, removeUploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: (partial) => fs.writeFile(partial, "copy") });
  await assert.rejects(removeUploadCopy({ ...copy, path: f.source.path }), /source|generated/i);
  await removeUploadCopy(copy);
  await assert.rejects(fs.access(copy.path), { code: "ENOENT" });
  await assert.rejects(fs.access(copy.uploadCopyManifestPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.source.path, "utf8"), "original audio and video bytes");
});

test("remux uses stream copy with audio one, hidden launch, and best-effort lower priority", async () => {
  const { runTrack1Remux } = await loadCopyModule();
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  let spawned;
  let priority;
  const pending = runTrack1Remux({
    sourcePath: "source.mkv", outputPath: "partial.mkv", ffmpegPath: "ffmpeg.exe",
    spawnProcess: (...args) => { spawned = args; return child; },
    setPriority: (...args) => { priority = args; throw new Error("priority unsupported"); },
  });
  child.emit("spawn");
  child.emit("close", 0);
  await pending;
  assert.deepEqual(spawned[1], ["-nostdin", "-y", "-i", "source.mkv", "-map", "0:v", "-map", "0:a:0?", "-sn", "-dn", "-c", "copy", "partial.mkv"]);
  assert.equal(spawned[2].windowsHide, true);
  assert.deepEqual(priority, [12345, os.constants.priority.PRIORITY_BELOW_NORMAL]);
});

test("pause waits for ffmpeg to close before deleting its partial file", async (t) => {
  const { ensureTrack1UploadCopy, runTrack1Remux } = await loadCopyModule();
  const f = await fixture(t);
  let killed;
  const stopped = new Promise((resolve) => { killed = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 12345, kill: () => { killed(); return true; } });
  let partialPath;
  let settled = false;
  const pending = ensureTrack1UploadCopy(f.source, {
    cacheRoot: f.cacheRoot,
    prepare: async (partial) => {
      partialPath = partial;
      await fs.writeFile(partial, "writing");
      return runTrack1Remux({
        sourcePath: f.source.path, outputPath: partial, ffmpegPath: "ffmpeg.exe",
        spawnProcess: () => child, shouldPause: async () => true, pauseIntervalMs: 1,
      });
    },
  });
  pending.then(() => { settled = true; }, () => { settled = true; });
  // The only mocked timer is unreferenced, so keep this test alive until the simulated child closes.
  const keepAlive = setTimeout(() => {}, 10000);
  t.after(() => clearTimeout(keepAlive));
  await stopped;
  await delay(5);
  assert.equal(settled, false);
  await fs.access(partialPath);
  child.emit("close", null);
  await assert.rejects(pending, { code: "SOFTUCHIVE_PAUSED" });
  await assert.rejects(fs.access(partialPath), { code: "ENOENT" });
  await fs.access(f.source.path);
});

test("stronger source fingerprints preserve cache keys and detect replacement with preserved mtime", async (t) => {
  const { ensureTrack1UploadCopy, buildTrack1UploadCopyPath } = await loadCopyModule();
  const f = await fixture(t);
  const preservedTime = new Date("2026-09-01T12:00:00.000Z");
  await fs.utimes(f.source.path, preservedTime, preservedTime);
  const stat = await fs.stat(f.source.path);
  const source = { ...f.source, modifiedAtMs: stat.mtimeMs, changedAtMs: stat.ctimeMs, fileId: String(stat.ino), deviceId: String(stat.dev) };
  assert.equal(buildTrack1UploadCopyPath(source, f.cacheRoot), buildTrack1UploadCopyPath({ ...f.source, modifiedAtMs: stat.mtimeMs }, f.cacheRoot));
  const copy = await ensureTrack1UploadCopy(source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "saved copy") });
  await delay(20);
  await fs.writeFile(source.path, Buffer.alloc(source.size, 65));
  await fs.utimes(source.path, preservedTime, preservedTime);
  const changedStat = await fs.stat(source.path);
  assert.equal(changedStat.mtimeMs, source.modifiedAtMs);
  assert.equal(changedStat.size, source.size);
  await assert.rejects(ensureTrack1UploadCopy(source, { cacheRoot: f.cacheRoot, prepare: () => assert.fail("changed source was prepared") }), { code: "SOFTUCHIVE_UPLOAD_SOURCE_CHANGED" });
  assert.equal(await fs.readFile(copy.path, "utf8"), "saved copy");
});

test("disk-full preparation remains the reported failure if partial cleanup is also denied", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const full = Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
  const originalRm = fs.rm;
  let partialPath;
  try {
    fs.rm = async (target, options) => {
      if (String(target).endsWith(".partial.mkv")) throw Object.assign(new Error("fixture still open"), { code: "EBUSY" });
      return originalRm(target, options);
    };
    await assert.rejects(ensureTrack1UploadCopy(f.source, {
      cacheRoot: f.cacheRoot, prepare: async partial => { partialPath = partial; await fs.writeFile(partial, "partial"); throw full; },
    }), error => error === full);
  } finally { fs.rm = originalRm; }
  await fs.access(partialPath);
  assert.equal((await fs.readdir(path.dirname(partialPath))).length, 1, "no completed copy or manifest was published");
  assert.equal(await fs.readFile(f.source.path, "utf8"), "original audio and video bytes");
});

test("abort during preparation never commits cache media or its completion record", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(ensureTrack1UploadCopy(f.source, {
    cacheRoot: f.cacheRoot, signal: controller.signal,
    prepare: async partial => { await fs.writeFile(partial, "unfinished"); controller.abort(); },
  }), { name: "AbortError" });
  assert.deepEqual(await fs.readdir(path.join(f.cacheRoot, "youtube-upload-audio1")), []);
  await fs.access(f.source.path);
});

test("a source that grows during the final media flush is deferred before cache commit", async (t) => {
  const { ensureTrack1UploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const originalOpen = fs.open;
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".partial.mkv")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); await fs.appendFile(f.source.path, "new recording bytes"); };
      }
      return handle;
    };
    await assert.rejects(ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "copy") }), { code: "SOFTUCHIVE_UPLOAD_SOURCE_CHANGED" });
  } finally { fs.open = originalOpen; }
  assert.deepEqual(await fs.readdir(path.join(f.cacheRoot, "youtube-upload-audio1")), []);
  assert.match(await fs.readFile(f.source.path, "utf8"), /new recording bytes$/);
});

test("cleanup keeps its completion evidence until upload-session cleanup succeeds", async (t) => {
  const { ensureTrack1UploadCopy, removeUploadCopy } = await loadCopyModule();
  const f = await fixture(t);
  const copy = await ensureTrack1UploadCopy(f.source, { cacheRoot: f.cacheRoot, prepare: partial => fs.writeFile(partial, "copy") });
  const storageError = Object.assign(new Error("fixture session store failure"), { code: "EIO" });
  await assert.rejects(removeUploadCopy(copy, { afterMediaRemoved: async () => { throw storageError; } }), error => error === storageError);
  await fs.access(copy.uploadCopyManifestPath);
  await assert.rejects(fs.access(copy.path), { code: "ENOENT" });
  let cleared = false;
  await removeUploadCopy(copy, { afterMediaRemoved: async () => { cleared = true; } });
  assert.equal(cleared, true);
  await assert.rejects(fs.access(copy.uploadCopyManifestPath), { code: "ENOENT" });
  await fs.access(f.source.path);
});

test("remux rejects identical source/output paths and pre-aborted work without spawning", async () => {
  const { runTrack1Remux } = await loadCopyModule();
  const spawnProcess = () => assert.fail("ffmpeg must not spawn");
  await assert.rejects(runTrack1Remux({ sourcePath: "source.mkv", outputPath: path.resolve("source.mkv"), ffmpegPath: "ffmpeg", spawnProcess }), /cannot replace its source/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runTrack1Remux({ sourcePath: "source.mkv", outputPath: "partial.mkv", ffmpegPath: "ffmpeg", spawnProcess, signal: controller.signal }), { name: "AbortError" });
});

test("remux waits for aborted ffmpeg to close and preserves spawn error codes", async () => {
  const { runTrack1Remux } = await loadCopyModule();
  const controller = new AbortController();
  let killed = false;
  const child = Object.assign(new EventEmitter(), { kill: () => { killed = true; } });
  const pending = runTrack1Remux({ sourcePath: "source.mkv", outputPath: "partial.mkv", ffmpegPath: "ffmpeg", spawnProcess: () => child, signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await delay(1);
  assert.equal(killed, true);
  assert.equal(settled, false);
  child.emit("close", null);
  await assert.rejects(pending, { name: "AbortError" });

  const failed = new EventEmitter();
  const missing = runTrack1Remux({ sourcePath: "source.mkv", outputPath: "partial.mkv", ffmpegPath: "missing-ffmpeg", spawnProcess: () => failed });
  failed.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" }));
  failed.emit("close", -1);
  await assert.rejects(missing, error => error.code === "ENOENT" && error.cause.code === "ENOENT");
});

test("installed ffmpeg preserves synthetic encoded video and first-audio packet hashes", async (t) => {
  for (const executable of ["ffmpeg", "ffprobe"]) {
    const available = spawnSync(executable, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (available.error?.code === "ENOENT") return t.skip(`${executable} is not installed; no dependency is downloaded`);
    assert.equal(available.status, 0, available.stderr || available.error?.message);
  }
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const { ensureTrack1UploadCopy, runTrack1Remux } = await loadCopyModule();
  const f = await fixture(t);
  run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "1", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "ffv1", "-c:a", "pcm_s16le", f.source.path]);
  const stat = await fs.stat(f.source.path);
  const source = { ...f.source, size: stat.size, modifiedAtMs: stat.mtimeMs };
  const originalBytes = await fs.readFile(source.path);
  const copy = await ensureTrack1UploadCopy(source, {
    cacheRoot: f.cacheRoot,
    prepare: outputPath => runTrack1Remux({
      sourcePath: source.path, outputPath, ffmpegPath: "ffmpeg",
      spawnProcess: (executable, args, options) => spawn(executable, args, { ...options, stdio: "ignore" }),
    }),
  });
  const streams = filePath => JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", filePath])).streams;
  const inputStreams = streams(source.path);
  const outputStreams = streams(copy.path);
  assert.deepEqual(inputStreams.map(stream => stream.codec_type), ["video", "audio", "audio"]);
  assert.deepEqual(outputStreams.map(stream => stream.codec_type), ["video", "audio"]);
  for (const [index, fields] of [[0, ["codec_name", "pix_fmt", "width", "height", "r_frame_rate"]], [1, ["codec_name", "sample_fmt", "sample_rate", "channels"]]]) {
    for (const field of fields) assert.equal(outputStreams[index][field], inputStreams[index][field], field);
  }
  const packetHashes = filePath => run("ffmpeg", ["-nostdin", "-v", "error", "-i", filePath, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"]).trim();
  assert.equal(packetHashes(copy.path), packetHashes(source.path), "encoded video and first audio packets must remain byte-identical");
  assert.deepEqual(await fs.readFile(source.path), originalBytes, "source media must remain untouched");
});
