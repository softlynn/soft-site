import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
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
  assert.deepEqual(spawned[1], ["-y", "-i", "source.mkv", "-map", "0:v?", "-map", "0:a:0?", "-sn", "-dn", "-c", "copy", "partial.mkv"]);
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
