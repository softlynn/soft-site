import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
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

const startLockWorker = (lockPath, { gateRead = false } = {}) => {
  const moduleUrl = new URL("./pipeline_run_lock.mjs", import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises';
    import { acquirePipelineRunLock } from ${JSON.stringify(moduleUrl)};
    const lockPath = process.argv[1];
    let gated = false;
    const originalRead = fs.readFile;
    fs.readFile = async (...args) => {
      const contents = await originalRead(...args);
      if (${gateRead} && args[0] === lockPath && !gated) {
        gated = true;
        process.send({ type: 'read' });
        await new Promise(resolve => process.once('message', resolve));
      }
      return contents;
    };
    const release = await acquirePipelineRunLock(lockPath);
    process.send({ type: 'result', owned: typeof release === 'function' });
    await new Promise(resolve => process.once('message', resolve));
    if (release) await release();
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages = [];
  const listeners = new Set();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("message", message => { messages.push(message); for (const listener of listeners) listener(); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  return {
    child,
    exited,
    proceed: () => child.send({ proceed: true }),
    waitFor: (...types) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`Worker did not report ${types}: ${stderr}`)); }, 5000);
      const check = () => {
        const message = messages.find(candidate => types.includes(candidate.type));
        if (!message) return;
        clearTimeout(timeout);
        listeners.delete(check);
        resolve(message);
      };
      listeners.add(check);
      check();
    }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
};

test("independent stale-lock reapers never admit two live pipeline owners", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: "departed", createdAtMs: Date.now() }));
    const first = startLockWorker(lockPath, { gateRead: true });
    let second;
    try {
      await first.waitFor("read");
      second = startLockWorker(lockPath, { gateRead: true });
      const secondState = await second.waitFor("read", "result");
      first.proceed();
      const firstResult = await first.waitFor("result");
      if (secondState.type === "read") second.proceed();
      const secondResult = await second.waitFor("result");
      assert.equal(Number(firstResult.owned) + Number(secondResult.owned), 1);
    } finally {
      await Promise.all([first.stop(), second?.stop()]);
    }
  });
});

test("a killed pipeline owner is recovered with readable compatibility metadata", async () => {
  await withLockPath(async (lockPath) => {
    const worker = startLockWorker(lockPath);
    try {
      assert.equal((await worker.waitFor("result")).owned, true);
      const original = JSON.parse(await fs.readFile(lockPath, "utf8"));
      assert.equal(original.pid, worker.child.pid);
      assert.equal(typeof original.token, "string");
      assert.ok(Number.isFinite(original.createdAtMs));
      await worker.stop();
      const release = await acquirePipelineRunLock(lockPath);
      assert.equal(typeof release, "function");
      try { assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).pid, process.pid); }
      finally { await release(); }
      assert.deepEqual(await fs.readdir(path.dirname(lockPath)), []);
    } finally { await worker.stop(); }
  });
});

test("release reports filesystem failures instead of silently claiming success", async () => {
  await withLockPath(async (lockPath) => {
    const release = await acquirePipelineRunLock(lockPath);
    const originalRemove = fs.rm;
    fs.rm = async (target, ...args) => {
      if (target === lockPath) throw Object.assign(new Error("fixture permission failure"), { code: "EACCES" });
      return originalRemove(target, ...args);
    };
    try { await assert.rejects(release(), { code: "EACCES" }); }
    finally { fs.rm = originalRemove; }
  });
});

test("failed run retains ownership until its final runtime snapshot is written", async () => {
  const { runWithPipelineOwnership } = await import("./pipeline_run_lock.mjs");
  assert.equal(typeof runWithPipelineOwnership, "function", "failure reporting must finish before releasing runtime ownership");
  await withLockPath(async (lockPath) => {
    const releaseRunLock = await acquirePipelineRunLock(lockPath);
    let allowFinish;
    const heldFinish = new Promise((resolve) => { allowFinish = resolve; });
    let signalFinish;
    const finishStarted = new Promise((resolve) => { signalFinish = resolve; });
    let runtime = "old-running";
    const running = runWithPipelineOwnership({
      releaseRunLock,
      operation: async () => { throw new Error("fixture upload failure"); },
      onError: async () => { signalFinish(); await heldFinish; runtime = "old-error"; },
    });
    void running.catch(() => {});
    try {
      await finishStarted;
      const contender = await acquirePipelineRunLock(lockPath);
      try { assert.equal(contender, null, "a replacement run started before the old error snapshot settled"); }
      finally { if (contender) await contender(); }
      allowFinish();
      await assert.rejects(running, /fixture upload failure/);
      const next = await acquirePipelineRunLock(lockPath);
      assert.equal(typeof next, "function");
      try { runtime = "new-running"; await Promise.resolve(); assert.equal(runtime, "new-running"); }
      finally { await next(); }
    } finally { allowFinish(); await running.catch(() => {}); }
  });
});

test("failed runtime reporting still releases ownership and preserves the original run failure", async () => {
  const { runWithPipelineOwnership } = await import("./pipeline_run_lock.mjs");
  assert.equal(typeof runWithPipelineOwnership, "function");
  await withLockPath(async (lockPath) => {
    const releaseRunLock = await acquirePipelineRunLock(lockPath);
    await assert.rejects(runWithPipelineOwnership({
      releaseRunLock, operation: async () => { throw new Error("original failure"); },
      onError: async () => { throw new Error("runtime disk error"); },
    }), /original failure/);
    const next = await acquirePipelineRunLock(lockPath);
    assert.equal(typeof next, "function");
    await next();
  });
});

test("a contender without ownership cannot run work or replace the active runtime snapshot", async () => {
  const { runWithPipelineOwnership } = await import("./pipeline_run_lock.mjs");
  await withLockPath(async (lockPath) => {
    const releaseOwner = await acquirePipelineRunLock(lockPath);
    let runtime = { active: true, owner: "current" };
    try {
      const releaseContender = await acquirePipelineRunLock(lockPath);
      assert.equal(releaseContender, null);
      await runWithPipelineOwnership({
        releaseRunLock: releaseContender,
        operation: async () => { runtime = { active: false, owner: "contender" }; },
        onError: async () => { runtime = { active: false, owner: "contender-error" }; },
      });
      assert.deepEqual(runtime, { active: true, owner: "current" });
    } finally { await releaseOwner(); }
  });
});
