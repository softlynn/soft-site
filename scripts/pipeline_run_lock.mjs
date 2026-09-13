import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serializeFileUpdate } from "./pipeline_file_io.mjs";

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const ensureDirectory = (dir) => fs.mkdir(dir, { recursive: true });
const readJsonFile = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback; throw error; }
};

export const isCurrentProcessRunning = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

export const acquirePipelineRunLock = async (lockPath) => {
  return serializeFileUpdate(lockPath, async () => {
    await ensureDirectory(path.dirname(lockPath));
    const token = randomUUID();

    const tryWriteLock = async () => {
      const nowMs = Date.now();
      const payload = {
        pid: process.pid,
        token,
        createdAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs,
        argv: process.argv.slice(1),
      };
      await fs.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await tryWriteLock();
        return async () => {
          try {
            const current = await readJsonFile(lockPath, null);
            if (current?.token === token) await fs.rm(lockPath, { force: true });
          } catch {}
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;

        const existing = await readJsonFile(lockPath, null);
        const ownerAlive = isCurrentProcessRunning(existing?.pid);
        if (ownerAlive) return null;
        if (!existing?.pid) {
          const stat = await fs.stat(lockPath).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (stat && Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return null;
        }

        try {
          await fs.rm(lockPath, { force: true });
        } catch {}
      }
    }

    return null;
  });
};
