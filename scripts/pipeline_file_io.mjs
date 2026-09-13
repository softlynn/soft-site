import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const pendingWrites = new Map();

// Progress can arrive faster than storage responds. Keep one active and one
// latest pending snapshot; callers resolve only after that pending state is saved.
export const createSnapshotWriter = (write) => {
  let pending = null;
  let draining = null;
  return (snapshot) => {
    pending = snapshot;
    if (!draining) {
      draining = Promise.resolve().then(async () => {
        try {
          while (pending !== null) {
            const current = pending;
            pending = null;
            await write(current);
          }
        } finally {
          draining = null;
        }
      });
    }
    return draining;
  };
};

// Serialize the complete read/merge/write operation, not just its final write.
// The queue is process-local; atomic replacement also protects other readers.
export const serializeFileUpdate = (filePath, update) => {
  const resolved = path.resolve(filePath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = pendingWrites.get(key) || Promise.resolve();
  const result = previous.then(update);
  const settled = result.then(() => undefined, () => undefined);
  pendingWrites.set(key, settled);
  void settled.then(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
  return result;
};

export const writeJsonFileAtomic = async (filePath, payload) => {
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporaryPath, filePath);
        break;
      } catch (error) {
        // Windows readers/antivirus can briefly hold a file without delete sharing.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 10) throw error;
        await delay(Math.min(250, 10 * (2 ** attempt)) + Math.floor(Math.random() * 17));
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
};
