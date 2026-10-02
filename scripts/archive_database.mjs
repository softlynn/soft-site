import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonFileAtomic } from './pipeline_file_io.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const entryKey = entry => `${entry?.type || 'vod'}:${String(entry?.id ?? '')}`;

// Apply only changes made since the caller's snapshot. Concurrent edits win
// conflicts; disjoint fields and video parts are merged, never blindly replaced.
function mergeValue(base, proposed, latest, key = '') {
  if (isDeepStrictEqual(proposed, base)) return clone(latest);
  if (isDeepStrictEqual(latest, base)) return clone(proposed);
  if (Array.isArray(proposed) && Array.isArray(latest) && (key === 'youtube' || key === '$vods')) {
    const before = new Map((Array.isArray(base) ? base : []).map(row => [entryKey(row), row]));
    const wanted = new Map(proposed.map(row => [entryKey(row), row]));
    const current = new Map(latest.map(row => [entryKey(row), row]));
    const keys = new Set([...current.keys(), ...wanted.keys()]);
    return [...keys].flatMap(id => {
      const value = mergeValue(before.get(id), wanted.get(id), current.get(id));
      return value === undefined ? [] : [value];
    });
  }
  if (isObject(proposed) && isObject(latest) && (base === undefined || isObject(base))) {
    const result = {};
    for (const property of new Set([...Object.keys(base || {}), ...Object.keys(proposed), ...Object.keys(latest)])) {
      const value = mergeValue(base?.[property], proposed[property], latest[property], property);
      if (value !== undefined) result[property] = value;
    }
    return result;
  }
  return clone(latest);
}

export const mergeArchiveSnapshots = (base, proposed, latest) => mergeValue(base, proposed, latest, '$vods');

const processIsAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

async function removeOwner(lockPath, ownerName) {
  try {
    // Unique child ownership is essential: a delayed stale-lock remover must
    // never unlink a replacement owner's file or remove a nonempty directory.
    await fs.unlink(path.join(lockPath, ownerName));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fs.rmdir(lockPath).catch(error => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

async function reclaimDeadLocalOwner(lockPath) {
  try {
    const files = await fs.readdir(lockPath);
    if (files.length === 0) {
      await fs.rmdir(lockPath).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      });
      return;
    }
    if (files.length !== 1 || !/^owner-[\w-]+\.json$/.test(files[0])) return;
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, files[0]), 'utf8'));
    if (owner?.hostname === os.hostname() && !processIsAlive(owner.pid)) await removeOwner(lockPath, files[0]);
  } catch (error) {
    // Windows may deny inspection/removal while another process releases or
    // replaces this directory. Retry acquisition under its existing deadline;
    // only a successful candidate rename can grant ownership.
    if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
}

export async function acquireArchiveFileLock(filePath, { timeoutMs = 15_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const candidate = `${lockPath}.candidate-${process.pid}-${token}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.mkdir(candidate);
  try {
    await fs.writeFile(path.join(candidate, ownerName), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }), { flag: 'wx' });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        // Publish a NONEMPTY directory atomically. There is no uninitialized
        // owner window, including on POSIX where rename can replace empty dirs.
        await fs.rename(candidate, lockPath);
        return () => removeOwner(lockPath, ownerName);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await reclaimDeadLocalOwner(lockPath);
        if (Date.now() >= deadline) throw Object.assign(new Error('Archive database is busy; retry after the current update finishes.'), { code: 'ARCHIVE_LOCK_BUSY' });
        await delay(20 + Math.floor(Math.random() * 30));
      }
    }
  } finally {
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

async function readArchiveDocument(filePath, { allowMissing = true } = {}) {
  let contents;
  try { contents = await fs.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (allowMissing) return { rows: [], exists: false };
    throw Object.assign(new Error('The archive database is missing after it was previously loaded. Restore it before retrying.'), { code: 'ARCHIVE_DATABASE_MISSING' });
  }
  const rows = JSON.parse(contents);
  if (!Array.isArray(rows)) throw new Error('Archive database must contain a JSON array.');
  return { rows, exists: true };
}

export async function readArchiveDatabase(filePath, options) {
  return (await readArchiveDocument(filePath, options)).rows;
}

// Keep external network operations outside this transaction. Readers always
// see a complete JSON document; writers share ownership across processes.
export async function updateArchiveDatabase(filePath, updater, options) {
  const release = await acquireArchiveFileLock(filePath, options);
  try {
    const rows = await readArchiveDatabase(filePath, options);
    const next = await updater(rows);
    if (!Array.isArray(next)) throw new TypeError('Archive updater must return an array.');
    await writeJsonFileAtomic(filePath, next, { durable: true });
    return next;
  } finally { await release(); }
}

export function createArchiveSnapshotStore(filePath) {
  const baselines = new WeakMap();
  let observedExisting = false;
  let pending = Promise.resolve();
  const enqueue = operation => {
    const result = pending.then(operation);
    // A rejected write must reach its caller without poisoning later saves.
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    async read() {
      const { rows, exists } = await readArchiveDocument(filePath, { allowMissing: !observedExisting });
      observedExisting ||= exists;
      baselines.set(rows, clone(rows));
      return rows;
    },
    async write(rows) {
      if (!baselines.has(rows)) throw new Error('Read an archive snapshot before saving it.');
      // Capture this call's intent before the caller changes its live objects.
      const proposed = clone(rows);
      return enqueue(async () => {
        // The previous queued save establishes the baseline for this save.
        const base = baselines.get(rows);
        const saved = await updateArchiveDatabase(filePath, latest => mergeArchiveSnapshots(base, proposed, latest), { allowMissing: !observedExisting });
        observedExisting = true;
        // Baseline tracks what THIS caller has seen, not newer admin values that
        // are absent from its still-live objects. Otherwise its next save reverts them.
        baselines.set(rows, proposed);
        return saved;
      });
    },
    async mutate(rows, updater) {
      if (!baselines.has(rows)) throw new Error('Read an archive snapshot before updating it.');
      return enqueue(async () => {
        const saved = await updateArchiveDatabase(filePath, updater, { allowMissing: !observedExisting });
        observedExisting = true;
        rows.splice(0, rows.length, ...saved);
        baselines.set(rows, clone(saved));
        return rows;
      });
    },
  };
}
