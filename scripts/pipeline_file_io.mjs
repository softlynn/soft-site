import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const pendingWrites = new Map();
const syncedDirectoryChains = new Set();

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

const syncParentDirectory = async (directory) => {
  // Windows does not support opening directories for fsync through this API.
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some POSIX filesystems do not support directory fsync. I/O and permission
    // failures are real checkpoint failures and must still reach the caller.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
};

// Atomic replacement is sufficient for frequent UI progress. Critical journals
// opt into durable writes: flush file contents before rename, then the parent
// directory and its ancestor links where supported. Establish each chain once
// per process, and only remember it after every flush succeeds. A failed file
// flush never replaces the old file.
export const writeJsonFileAtomic = async (filePath, payload, { durable = false } = {}) => {
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  const parentDirectory = path.dirname(filePath);
  const firstCreatedDirectory = await fs.mkdir(parentDirectory, { recursive: true });
  if (firstCreatedDirectory && process.platform !== "win32") {
    const createdDirectory = path.resolve(firstCreatedDirectory);
    for (const directory of syncedDirectoryChains) {
      const relative = path.relative(createdDirectory, directory);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        syncedDirectoryChains.delete(directory);
      }
    }
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (durable) {
      const handle = await fs.open(temporaryPath, "wx");
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    }
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
    if (durable && process.platform !== "win32") {
      const containingDirectory = path.resolve(parentDirectory);
      let directory = containingDirectory;
      const lastDirectory = syncedDirectoryChains.has(containingDirectory) ? containingDirectory : path.parse(directory).root;
      // A retry sees existing directories even if their ancestor flush failed.
      // First writes also cover ancestors created by startup/lock code before us.
      for (;;) {
        await syncParentDirectory(directory);
        if (directory === lastDirectory) break;
        directory = path.dirname(directory);
      }
      syncedDirectoryChains.add(containingDirectory);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
};
