import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { acquireArchiveFileLock } from "./archive_database.mjs";

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const isValidProcessId = (pid) => (typeof pid === "number" || (typeof pid === "string" && /^[1-9]\d*$/.test(pid))) &&
  Number.isSafeInteger(Number(pid)) && Number(pid) > 0;
const readJsonFile = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback; throw error; }
};

export const isCurrentProcessRunning = (pid) => {
  if (!isValidProcessId(pid)) return false;
  const numericPid = Number(pid);
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

export const acquirePipelineRunLock = async (lockPath) => {
  let releaseGuard;
  try {
    // Keep the cross-process guard for the whole run. A check-then-unlink of
    // stale JSON alone lets a delayed reaper remove a newly admitted owner.
    releaseGuard = await acquireArchiveFileLock(lockPath, { timeoutMs: 100 });
  } catch (error) {
    if (error.code === "ARCHIVE_LOCK_BUSY") return null;
    throw error;
  }

  let acquired = false;
  try {
    const existing = await readJsonFile(lockPath, null);
    // Preserve compatibility with a pipeline already running the old version.
    if (existing?.hostname && existing.hostname !== os.hostname()) return null;
    // Invalid ownership metadata is not proof that an owner exited. In
    // particular, a truthy malformed PID must not bypass the incomplete grace.
    if (existing && Object.hasOwn(existing, "pid") && !isValidProcessId(existing.pid)) return null;
    if (isCurrentProcessRunning(existing?.pid)) return null;
    if (!existing?.pid) {
      const stat = await fs.stat(lockPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat && Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return null;
    }

    await fs.rm(lockPath, { force: true });
    const token = randomUUID();
    const nowMs = Date.now();
    const payload = {
      pid: process.pid,
      hostname: os.hostname(),
      token,
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      argv: process.argv.slice(1),
    };
    try {
      await fs.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }

    acquired = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        const current = await readJsonFile(lockPath, null);
        if (current?.token === token) await fs.rm(lockPath, { force: true });
      } finally {
        await releaseGuard();
      }
    };
  } finally {
    if (!acquired) await releaseGuard();
  }
};

// Runtime snapshots belong to the run holding this lock. Finish failure
// reporting before admitting a successor that may write a newer snapshot.
export const runWithPipelineOwnership = async ({ releaseRunLock, operation, onError }) => {
  if (typeof releaseRunLock !== "function") return;
  try {
    return await operation();
  } catch (error) {
    try { await onError(error); } catch {}
    throw error;
  } finally {
    await releaseRunLock();
  }
};
