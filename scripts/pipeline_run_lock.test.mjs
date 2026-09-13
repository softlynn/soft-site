import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { acquirePipelineRunLock } from "./pipeline_run_lock.mjs";

const withLockPath = async (run) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-lock-"));
  try { await run(path.join(dir, "run.lock.json")); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test("a live owner keeps its lock even after an upload lasting over twelve hours", async () => {
  await withLockPath(async (lockPath) => {
    const existing = { pid: process.pid, createdAtMs: Date.now() - 13 * 60 * 60 * 1000 };
    await fs.writeFile(lockPath, JSON.stringify(existing));
    const release = await acquirePipelineRunLock(lockPath);
    try { assert.equal(release, null); }
    finally { if (release) await release(); }
  });
});

test("a departed owner is recovered and concurrent callers still admit only one runner", async () => {
  await withLockPath(async (lockPath) => {
    const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0);
    await fs.writeFile(lockPath, JSON.stringify({ pid: Number(child.stdout.trim()), createdAtMs: Date.now() }));
    const acquired = await Promise.all(Array.from({ length: 8 }, () => acquirePipelineRunLock(lockPath)));
    const owners = acquired.filter(Boolean);
    try { assert.equal(owners.length, 1); }
    finally { await Promise.all(owners.map((release) => release())); }
  });
});

test("releasing an old lock cannot remove a replacement owner", async () => {
  await withLockPath(async (lockPath) => {
    const release = await acquirePipelineRunLock(lockPath);
    const replacement = { pid: process.pid, createdAtMs: Date.now(), token: "replacement" };
    await fs.writeFile(lockPath, JSON.stringify(replacement));
    await release();
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), replacement);
  });
});

test("a newly created empty lock is treated as another owner still writing", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(lockPath, "");
    assert.equal(await acquirePipelineRunLock(lockPath), null);
  });
});

test("normal acquisition excludes another runner and release allows the next run", async () => {
  await withLockPath(async (lockPath) => {
    const release = await acquirePipelineRunLock(lockPath);
    assert.equal(typeof release, "function");
    assert.equal(await acquirePipelineRunLock(lockPath), null);
    await release();
    const nextRelease = await acquirePipelineRunLock(lockPath);
    assert.equal(typeof nextRelease, "function");
    await nextRelease();
  });
});
