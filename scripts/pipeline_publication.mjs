import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { acquireArchiveFileLock, mergeArchiveSnapshots } from "./archive_database.mjs";
import { serializeFileUpdate, writeJsonFileAtomic } from "./pipeline_file_io.mjs";

const parseVodIndex = (contents) => {
  const parsed = contents === null ? [] : JSON.parse(contents);
  if (!Array.isArray(parsed)) throw new Error("Archive index must contain a JSON array.");
  return parsed;
};

export const mergePublicationContents = ({ base, proposed, latest, isVodIndex = false }) => {
  const snapshots = isVodIndex ? [base, proposed, latest].map(parseVodIndex) : null;
  if (proposed === base) return latest;
  if (latest === base || latest === proposed) return proposed;
  if (isVodIndex && proposed !== null && latest !== null) {
    const [before, wanted, current] = snapshots;
    return `${JSON.stringify(mergeArchiveSnapshots(before, wanted, current), null, 2)}\n`;
  }
  throw new Error("Archive data changed remotely; refusing to overwrite it. Publication remains queued for reconciliation.");
};

const validateEntry = (entry) => {
  if (!entry || typeof entry !== "object" || typeof entry.gitPath !== "string" ||
      !entry.gitPath || /[\\\0]/.test(entry.gitPath) || path.posix.isAbsolute(entry.gitPath) ||
      entry.gitPath.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      typeof entry.sourcePath !== "string" || !entry.sourcePath ||
      typeof entry.baseRevision !== "string" || !entry.baseRevision.trim()) {
    throw new Error("Invalid archive publication journal entry.");
  }
  return entry;
};

const snapshotDirectory = (journalPath) => `${path.resolve(journalPath)}.snapshots`;
const validateSnapshot = (journalPath, entry) => {
  for (const [field, digest] of [["snapshotPath", "snapshotSha256"], ["baseSnapshotPath", "baseSnapshotSha256"]]) {
    if (!Object.hasOwn(entry, field)) continue;
    if (entry[field] === null && (field === "baseSnapshotPath" || entry.deleted === true)) continue;
    if (typeof entry[field] !== "string" ||
        path.dirname(path.resolve(entry[field])) !== snapshotDirectory(journalPath) ||
        !/^snapshot-[a-f0-9-]+\.bin$/.test(path.basename(entry[field])) ||
        !/^[a-f0-9]{64}$/.test(entry[digest] || "")) {
      throw new Error("Invalid archive publication snapshot.");
    }
  }
};

const readJournal = async (journalPath) => {
  try {
    const pending = JSON.parse(await fs.readFile(journalPath, "utf8"));
    if (!pending || !Array.isArray(pending.entries) ||
        (pending.baselines !== undefined && !Array.isArray(pending.baselines))) throw new Error("Invalid archive publication journal.");
    const baselines = pending.baselines || [];
    for (const entries of [pending.entries, baselines]) {
      const paths = new Set();
      for (const entry of entries) {
        validateEntry(entry);
        validateSnapshot(journalPath, entry);
        if (paths.has(entry.gitPath)) throw new Error("Duplicate path in archive publication journal.");
        paths.add(entry.gitPath);
      }
    }
    if (baselines.some((entry) => !Object.hasOwn(entry, "snapshotPath"))) throw new Error("Invalid archive publication baseline.");
    return { entries: pending.entries, baselines };
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], baselines: [] };
    throw error;
  }
};

const withJournalLock = (journalPath, operation) => serializeFileUpdate(journalPath, async () => {
  const release = await acquireArchiveFileLock(journalPath);
  try { return await operation(); }
  finally { await release(); }
});

const writePending = (journalPath, entries, baselines) => writeJsonFileAtomic(journalPath, {
  entries, baselines, updatedAt: new Date().toISOString(),
}, { durable: true });

const sha256File = async (filePath) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

// A queue entry can precede the local data write. Freeze its contents only when
// publication starts, then reuse that exact snapshot after network/Git failures.
const snapshotEntry = async (journalPath, entry) => {
  if (Object.hasOwn(entry, "snapshotPath") && !entry.refreshSnapshot) {
    if (entry.snapshotPath !== null && await sha256File(entry.snapshotPath) !== entry.snapshotSha256) {
      throw new Error(`Archive publication snapshot is corrupt: ${entry.gitPath}.`);
    }
    return entry;
  }
  const { refreshSnapshot, snapshotPath: previousPath, snapshotSha256, ...intent } = entry;
  if (entry.deleted === true) return { ...intent, snapshotPath: null };
  const directory = snapshotDirectory(journalPath);
  await fs.mkdir(directory, { recursive: true });
  const snapshotPath = path.join(directory, `snapshot-${randomUUID()}.bin`);
  // An absent source is unfinished work, never an implicit deletion request.
  await fs.copyFile(entry.sourcePath, snapshotPath);
  const handle = await fs.open(snapshotPath, "r+");
  try { await handle.sync(); }
  finally { await handle.close(); }
  if (process.platform !== "win32") {
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) throw error;
    } finally { await directoryHandle.close(); }
  }
  return { ...intent, snapshotPath, snapshotSha256: await sha256File(snapshotPath) };
};

// Bounded cleanup happens only after a durable journal update. Failed publishes
// retain all snapshots; a later successful operation can collect crash orphans.
const cleanupSnapshots = async (journalPath, entries) => {
  const retained = new Set(entries.flatMap((entry) => [entry.snapshotPath, entry.baseSnapshotPath]).filter(Boolean));
  let removed = 0;
  let inspected = 0;
  try {
    for await (const entry of await fs.opendir(snapshotDirectory(journalPath))) {
      if (removed >= 32 || inspected >= 128) break;
      inspected += 1;
      const candidate = path.join(snapshotDirectory(journalPath), entry.name);
      if (entry.isFile() && /^snapshot-[a-f0-9-]+\.bin$/.test(entry.name) && !retained.has(candidate)) {
        await fs.unlink(candidate);
        removed += 1;
      }
    }
  } catch { /* Cleanup failure must not turn successful publication into failure. */ }
};

export const queueArchivePublication = (journalPath, entries) => {
  // Capture the caller's entry metadata before waiting for another transaction.
  const proposed = entries.map((entry) => ({ ...validateEntry(entry) }));
  return withJournalLock(journalPath, async () => {
    const journal = await readJournal(journalPath);
    const pending = new Map(journal.entries.map((entry) => [entry.gitPath, entry]));
    const baselines = new Map(journal.baselines.map((entry) => [entry.gitPath, entry]));
    for (const entry of proposed) {
      const previous = pending.get(entry.gitPath);
      const next = { ...entry, baseRevision: previous?.baseRevision ?? entry.baseRevision };
      delete next.baseSnapshotPath;
      delete next.baseSnapshotSha256;
      if (previous && Object.hasOwn(previous, "baseSnapshotPath")) {
        next.baseSnapshotPath = previous.baseSnapshotPath;
        next.baseSnapshotSha256 = previous.baseSnapshotSha256;
      } else if (!previous && baselines.has(entry.gitPath)) {
        const baseline = baselines.get(entry.gitPath);
        next.baseSnapshotPath = baseline.snapshotPath;
        next.baseSnapshotSha256 = baseline.snapshotSha256;
      }
      // Requeue precedes the next source write. Retain the last durable bytes
      // until their replacement has been captured and journaled successfully.
      delete next.snapshotPath;
      delete next.snapshotSha256;
      delete next.refreshSnapshot;
      if (previous && Object.hasOwn(previous, "snapshotPath")) {
        next.snapshotPath = previous.snapshotPath;
        if (previous.snapshotSha256) next.snapshotSha256 = previous.snapshotSha256;
        next.refreshSnapshot = true;
        // A deletion snapshot remains valid until new source contents exist.
        if (previous.snapshotPath === null) delete next.snapshotPath;
      }
      pending.set(entry.gitPath, next);
    }
    const next = [...pending.values()];
    await writePending(journalPath, next, journal.baselines);
    await cleanupSnapshots(journalPath, [...next, ...journal.baselines]);
  });
};

export const publishPendingArchive = (journalPath, publish, { snapshotSources = false } = {}) => withJournalLock(journalPath, async () => {
  const journal = await readJournal(journalPath);
  let entries = journal.entries;
  if (entries.length === 0) return false;
  if (snapshotSources) {
    const captured = [];
    for (const entry of entries) {
      if (entry.baseSnapshotPath && await sha256File(entry.baseSnapshotPath) !== entry.baseSnapshotSha256) {
        throw new Error(`Archive publication baseline is corrupt: ${entry.gitPath}.`);
      }
      captured.push(await snapshotEntry(journalPath, entry));
    }
    entries = captured;
    // This checkpoint precedes every remote action, including local commits.
    await writePending(journalPath, entries, journal.baselines);
  }
  await publish(entries);
  const baselines = new Map(journal.baselines.map((entry) => [entry.gitPath, entry]));
  for (const entry of entries) {
    if (!Object.hasOwn(entry, "snapshotPath")) continue;
    const { baseSnapshotPath, baseSnapshotSha256, refreshSnapshot, ...acknowledged } = entry;
    baselines.set(entry.gitPath, acknowledged);
  }
  // The acknowledged proposal is this caller's future baseline. Using stale
  // local HEAD drops later edits; using the merged remote content reverts admin
  // values that this caller has never seen. Neither requires changing checkout.
  const acknowledged = [...baselines.values()];
  await writePending(journalPath, [], acknowledged);
  await cleanupSnapshots(journalPath, acknowledged);
  return true;
});

const git = (cwd, args) => {
  const result = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Archive publication git ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
};

const gitBlob = (cwd, revision, gitPath) => {
  // ls-tree returns empty for a missing path, while invalid revisions and Git
  // failures remain errors. They must never masquerade as an absent merge base.
  const commit = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
  const record = git(cwd, ["ls-tree", "-z", commit, "--", gitPath]);
  if (!record) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(record);
  if (!match || match[3] !== gitPath) throw new Error(`Archive publication path is not a regular file: ${gitPath}.`);
  return match[2];
};

export const applyArchivePublicationToWorktree = async ({ entries, repoRoot, worktreeDir, vodsDataPath }) => {
  for (const entry of entries) {
    const { sourcePath, gitPath, baseRevision } = validateEntry(entry);
    const destinationPath = path.resolve(worktreeDir, ...gitPath.split("/"));
    const relative = path.relative(path.resolve(worktreeDir), destinationPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Archive publish path escaped its temporary worktree.");
    }
    // A symlink in any existing ancestor could redirect writes outside checkout.
    for (let ancestor = path.dirname(destinationPath); ancestor !== path.resolve(worktreeDir); ancestor = path.dirname(ancestor)) {
      try {
        if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error(`Archive publish path contains a symlink: ${gitPath}.`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const hasBaseSnapshot = Object.hasOwn(entry, "baseSnapshotPath");
    const baseBlob = hasBaseSnapshot
      ? (entry.baseSnapshotPath === null ? null : git(repoRoot, ["hash-object", `--path=${gitPath}`, "--", entry.baseSnapshotPath]).trim())
      : gitBlob(repoRoot, baseRevision, gitPath);
    const remoteBlob = gitBlob(worktreeDir, "HEAD", gitPath);
    const proposedPath = Object.hasOwn(entry, "snapshotPath") ? entry.snapshotPath : sourcePath;
    const deleted = entry.deleted === true;
    const isVodIndex = path.resolve(sourcePath) === path.resolve(vodsDataPath);
    const proposedContents = isVodIndex && !deleted ? await fs.readFile(proposedPath, "utf8") : null;
    if (isVodIndex && !deleted) parseVodIndex(proposedContents);
    const proposedBlob = deleted ? null : git(repoRoot, ["hash-object", `--path=${gitPath}`, "--", proposedPath]).trim();
    if (proposedBlob === remoteBlob || proposedBlob === baseBlob) continue;
    if (remoteBlob !== baseBlob) {
      if (!isVodIndex || deleted || !remoteBlob) {
        throw new Error(`Archive file ${gitPath} changed remotely; publication remains queued instead of overwriting it.`);
      }
      const merged = mergePublicationContents({
        base: baseBlob ? (hasBaseSnapshot ? await fs.readFile(entry.baseSnapshotPath, "utf8") : git(repoRoot, ["cat-file", "blob", baseBlob])) : null,
        proposed: proposedContents,
        latest: git(worktreeDir, ["cat-file", "blob", remoteBlob]), isVodIndex: true,
      });
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.writeFile(destinationPath, merged, "utf8");
    } else if (deleted) {
      await fs.rm(destinationPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(proposedPath, destinationPath);
    }
  }
};
