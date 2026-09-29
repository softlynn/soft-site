import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshotWriter, serializeFileUpdate, writeJsonFileAtomic } from "./pipeline_file_io.mjs";

test("a burst of progress snapshots waits for the current write and persists only the latest pending state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-snapshots-"));
  let release;
  const heldWrite = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let writes = 0;
  const file = path.join(dir, "state.json");
  const persist = createSnapshotWriter(async (snapshot) => {
    writes++;
    if (writes === 1) { started(); await heldWrite; }
    await writeJsonFileAtomic(file, snapshot);
  });
  try {
    const first = persist({ stage: "uploading", percent: 1 });
    await firstStarted;
    const pending = [];
    for (let percent = 2; percent < 100; percent++) pending.push(persist({ stage: "uploading", percent }));
    pending.push(persist({ stage: "complete", percent: 100 }));
    const concurrentWrites = writes;
    release();
    await Promise.all([first, ...pending]);
    assert.equal(concurrentWrites, 1, "progress writes overlapped the outstanding disk write");
    assert.equal(writes, 2, "intermediate snapshots were not coalesced");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { stage: "complete", percent: 100 });
  } finally {
    release();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a rejected file update does not poison subsequent writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-write-recovery-"));
  const file = path.join(dir, "state.json");
  try {
    await assert.rejects(serializeFileUpdate(file, async () => { throw new Error("disk busy"); }), /disk busy/);
    await serializeFileUpdate(file, () => writeJsonFileAtomic(file, { recovered: true }));
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { recovered: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failed snapshot is reported and the writer accepts a later retry", async () => {
  let fail = true;
  let stored;
  const persist = createSnapshotWriter(async (snapshot) => {
    if (fail) throw new Error("disk busy");
    stored = snapshot;
  });
  await assert.rejects(persist({ percent: 1 }), /disk busy/);
  fail = false;
  await persist({ percent: 2 });
  assert.deepEqual(stored, { percent: 2 });
});

test("a durable flush failure preserves the previous file and removes its temporary replacement", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-flush-failure-"));
  const file = path.join(dir, "checkpoint.json");
  const originalOpen = fs.open;
  try {
    await fs.writeFile(file, '{"confirmedBytes":8}\n');
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(`${file}.`) && String(args[0]).endsWith(".tmp")) {
        handle.sync = async () => { throw Object.assign(new Error("fixture flush failure"), { code: "EIO" }); };
      }
      return handle;
    };
    await assert.rejects(writeJsonFileAtomic(file, { confirmedBytes: 16 }, { durable: true }), { code: "EIO" });
    assert.equal(await fs.readFile(file, "utf8"), '{"confirmedBytes":8}\n');
    assert.deepEqual(await fs.readdir(dir), ["checkpoint.json"]);
  } finally {
    fs.open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ordinary progress writes do not request a durable disk flush", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-progress-write-"));
  const file = path.join(dir, "progress.json");
  const originalOpen = fs.open;
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      handle.sync = async () => { throw new Error("progress requested an unnecessary disk flush"); };
      return handle;
    };
    await writeJsonFileAtomic(file, { percent: 50 });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { percent: 50 });
  } finally {
    fs.open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const [code, shouldReject] of [["EINVAL", false], ["EIO", true]]) {
  test(`POSIX directory flush ${code} is ${shouldReject ? "reported" : "treated as unsupported"}`, { skip: process.platform === "win32" }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-directory-flush-"));
    const file = path.join(dir, "checkpoint.json");
    const originalOpen = fs.open;
    try {
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === dir) handle.sync = async () => { throw Object.assign(new Error("fixture directory flush"), { code }); };
        return handle;
      };
      const write = writeJsonFileAtomic(file, { saved: true }, { durable: true });
      if (shouldReject) await assert.rejects(write, { code });
      else await write;
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { saved: true });
      assert.deepEqual(await fs.readdir(dir), ["checkpoint.json"]);
    } finally {
      fs.open = originalOpen;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

// Keep file I/O real. Windows cannot open directory handles, so emulate only
// those handles and the POSIX branch; POSIX runners perform the actual fsyncs.
const withPosixDirectorySync = async (onSync, run) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalOpen = fs.open;
  const originalMkdir = fs.mkdir;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    if (platform.value === "win32") {
      // Node normally strips the native Windows namespace from mkdir's result;
      // preserve that behavior while this test selects the POSIX sync branch.
      fs.mkdir = async (...args) => {
        const created = await originalMkdir(...args);
        return created?.startsWith("\\\\?\\") ? created.slice(4) : created;
      };
    }
    fs.open = async (target, flags, ...args) => {
      if (flags !== "r" || !(await fs.stat(target)).isDirectory()) return originalOpen(target, flags, ...args);
      const handle = platform.value === "win32"
        ? { sync: async () => {}, close: async () => {} }
        : await originalOpen(target, flags, ...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await onSync(target); await sync(); };
      return handle;
    };
    await run();
  } finally {
    fs.open = originalOpen;
    fs.mkdir = originalMkdir;
    Object.defineProperty(process, "platform", platform);
  }
};

const ancestorDirectories = (directory) => {
  const result = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
};

test("durable checkpoints flush newly created ancestor links after replacing the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-new-ancestors-"));
  const file = path.join(root, "state", "upload-sessions", "checkpoint.json");
  const synced = [];
  try {
    await withPosixDirectorySync(async (directory) => {
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { saved: true });
      synced.push(directory);
    }, () => writeJsonFileAtomic(file, { saved: true }, { durable: true }));
    assert.deepEqual(synced, ancestorDirectories(path.dirname(file)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("durable checkpoints flush precreated ancestors once and only the containing directory thereafter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-existing-ancestors-"));
  const directory = path.join(root, "state", "upload-sessions");
  const synced = [];
  try {
    await fs.mkdir(directory, { recursive: true });
    await withPosixDirectorySync(async (target) => { synced.push(target); }, async () => {
      const file = path.join(directory, "checkpoint.json");
      await writeJsonFileAtomic(file, { saved: 1 }, { durable: true });
      assert.deepEqual(synced, ancestorDirectories(directory));
      synced.length = 0;
      await writeJsonFileAtomic(file, { saved: 2 }, { durable: true });
      assert.deepEqual(synced, [directory]);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an ancestor flush error cannot acknowledge a newly created checkpoint directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-ancestor-failure-"));
  const file = path.join(root, "state", "upload-sessions", "checkpoint.json");
  try {
    await withPosixDirectorySync(async (directory) => {
      if (directory === root) throw Object.assign(new Error("fixture ancestor flush"), { code: "EIO" });
    }, () => assert.rejects(writeJsonFileAtomic(file, { saved: true }, { durable: true }), { code: "EIO" }));
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { saved: true });
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["checkpoint.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a retry must flush the ancestor that failed after the checkpoint was renamed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-ancestor-retry-"));
  const file = path.join(root, "state", "upload-sessions", "checkpoint.json");
  const synced = [];
  let failAncestor = true;
  try {
    await withPosixDirectorySync(async (directory) => {
      synced.push(directory);
      if (directory === root && failAncestor) throw Object.assign(new Error("fixture ancestor retry"), { code: "EIO" });
    }, async () => {
      await assert.rejects(writeJsonFileAtomic(file, { saved: 1 }, { durable: true }), { code: "EIO" });
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { saved: 1 });
      synced.length = 0;
      await assert.rejects(writeJsonFileAtomic(file, { saved: 2 }, { durable: true }), { code: "EIO" });
      assert.ok(synced.includes(root), "retry bypassed the failed ancestor flush");
      failAncestor = false;
      synced.length = 0;
      await writeJsonFileAtomic(file, { saved: 3 }, { durable: true });
      assert.deepEqual(synced, ancestorDirectories(path.dirname(file)));
      synced.length = 0;
      await writeJsonFileAtomic(file, { saved: 4 }, { durable: true });
      assert.deepEqual(synced, [path.dirname(file)]);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recreated checkpoint directories must establish their ancestor durability again", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-recreated-ancestors-"));
  const directory = path.join(root, "state", "upload-sessions");
  const file = path.join(directory, "checkpoint.json");
  const synced = [];
  try {
    await withPosixDirectorySync(async (target) => { synced.push(target); }, async () => {
      await writeJsonFileAtomic(file, { saved: 1 }, { durable: true });
      assert.equal(path.relative(root, directory), path.join("state", "upload-sessions"));
      await fs.rm(directory, { recursive: true, force: true });
      synced.length = 0;
      await writeJsonFileAtomic(file, { saved: 2 }, { durable: true });
      assert.deepEqual(synced, ancestorDirectories(directory));
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
