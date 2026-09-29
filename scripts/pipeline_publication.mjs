import fs from "node:fs/promises";
import { mergeArchiveSnapshots } from "./archive_database.mjs";
import { serializeFileUpdate, writeJsonFileAtomic } from "./pipeline_file_io.mjs";

export const mergePublicationContents = ({ base, proposed, latest, isVodIndex = false }) => {
  if (proposed === base) return latest;
  if (latest === base || latest === proposed) return proposed;
  if (isVodIndex && proposed !== null && latest !== null) {
    const before = base === null ? [] : JSON.parse(base);
    const wanted = JSON.parse(proposed);
    const current = JSON.parse(latest);
    if (![before, wanted, current].every(Array.isArray)) throw new Error("Archive index must contain a JSON array.");
    return `${JSON.stringify(mergeArchiveSnapshots(before, wanted, current), null, 2)}\n`;
  }
  throw new Error("Archive data changed remotely; refusing to overwrite it. Publication remains queued for reconciliation.");
};

const readPending = async (journalPath) => {
  try {
    const pending = JSON.parse(await fs.readFile(journalPath, "utf8"));
    if (!Array.isArray(pending.entries)) throw new Error("Invalid archive publication journal.");
    return pending.entries;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

export const queueArchivePublication = (journalPath, entries) => serializeFileUpdate(journalPath, async () => {
  const pending = new Map((await readPending(journalPath)).map((entry) => [entry.gitPath, entry]));
  for (const entry of entries) {
    if (!pending.has(entry.gitPath)) pending.set(entry.gitPath, entry);
  }
  await writeJsonFileAtomic(journalPath, { entries: [...pending.values()], updatedAt: new Date().toISOString() }, { durable: true });
});

export const publishPendingArchive = (journalPath, publish) => serializeFileUpdate(journalPath, async () => {
  const entries = await readPending(journalPath);
  if (entries.length === 0) return false;
  await publish(entries);
  await writeJsonFileAtomic(journalPath, { entries: [], updatedAt: new Date().toISOString() }, { durable: true });
  return true;
});
