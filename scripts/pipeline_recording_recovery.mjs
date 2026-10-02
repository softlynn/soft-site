import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordingSourceIdentity, recordingSourceMatches } from "./pipeline_recordings.mjs";
import { buildTrack1UploadCopyPath } from "./pipeline_upload_copy.mjs";

const TERMINAL_STATUSES = new Set(["completed", "ignored_short", "ignored_short_uploaded", "skipped_manual"]);
export const isUnresolvedRecordingUploadCheckpoint = (checkpoint) => Boolean(checkpoint) &&
  (!TERMINAL_STATUSES.has(checkpoint.status) || (checkpoint.status === "skipped_manual" && !checkpoint.uploadArtifactsClearedAt));

// Changing a selection policy (for example, increasing the minimum duration)
// cannot finalize an earlier upload or discard its original source/media pin.
export const makeTerminalRecordingDeferral = (recording, terminalStatus, checkpoint) => {
  if (!TERMINAL_STATUSES.has(terminalStatus)) throw new TypeError("Recording deferral requires a terminal status.");
  if (isUnresolvedRecordingUploadCheckpoint(checkpoint)) return null;
  return {
    status: terminalStatus,
    source: recordingSourceIdentity(recording),
    durationSeconds: Math.floor(recording.durationSeconds),
    processedAt: new Date().toISOString(),
  };
};
const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left, right) => typeof left === "string" && typeof right === "string" && normalize(left) === normalize(right);
const normalizedName = (value) => process.platform === "win32" ? path.basename(value).toLowerCase() : path.basename(value);
const validSource = (value) => Number.isSafeInteger(value?.size) && value.size > 0 && Number.isFinite(value?.modifiedAtMs);
const recoveryRequired = (detail) => Object.assign(new Error(
  `${detail} Preserve the recording, prepared media, and private upload checkpoints. Restore the previous source/cache configuration or verify the earlier YouTube upload before retrying.`,
), { code: "SOFTUCHIVE_RECORDING_RECOVERY_REQUIRED" });

// A session can outlive a stale worker marker and a cache configuration change.
// Inspect only private checkpoint files, with strict bounds, and never include
// their contents or authenticated URLs in errors/logs.
const readSessionPaths = async (directory, { maxEntries, maxSessionBytes }) => {
  let handle;
  try { handle = await fs.opendir(directory); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw recoveryRequired("The private upload checkpoint directory cannot be inspected.");
  }
  const paths = [];
  let entries = 0;
  for await (const entry of handle) {
    if (++entries > maxEntries) throw recoveryRequired("The private upload checkpoint directory exceeds the safe inspection limit.");
    if (!/^[a-f0-9]{64}\.json$/i.test(entry.name)) continue;
    if (!entry.isFile()) throw recoveryRequired("A private upload checkpoint is not a regular file.");
    let file;
    try {
      file = await fs.open(path.join(directory, entry.name), "r");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxSessionBytes) throw new Error("invalid checkpoint size");
      const buffer = Buffer.alloc(maxSessionBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxSessionBytes) throw new Error("checkpoint grew beyond limit");
      const session = JSON.parse(buffer.toString("utf8", 0, length));
      const sourcePath = session?.fingerprint?.path;
      if (session?.version !== 1 || typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw new Error("missing session identity");
      const key = createHash("sha256").update(normalize(sourcePath)).digest("hex");
      if (entry.name.toLowerCase() !== `${key}.json`) throw new Error("session identity does not match its key");
      paths.push(sourcePath);
    } catch (error) {
      // Files are atomically replaced or removed by the serialized session store.
      // A disappeared entry is safe to omit; unreadable evidence is not.
      if (error.code !== "ENOENT") throw recoveryRequired("A private upload checkpoint cannot be verified.");
    } finally {
      if (file) {
        try { await file.close(); }
        catch { throw recoveryRequired("A private upload checkpoint could not be read reliably."); }
      }
    }
  }
  return paths;
};

// Read-only: run before changing a recording's processing marker or generating
// another copy. Identifiable source/path conflicts defer just that candidate.
// Unreadable private evidence blocks all candidates until it can be verified:
// its ownership cannot safely be inferred from a filename alone.
export const assertRecordingUploadRecoverySafe = async ({
  recording, checkpoint, cacheRoot, sessionDirectory,
  maxEntries = 2048, maxSessionBytes = 64 * 1024,
}) => {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxSessionBytes) || maxSessionBytes < 1) {
    throw new TypeError("Recovery inspection limits must be positive integers.");
  }
  const unresolved = isUnresolvedRecordingUploadCheckpoint(checkpoint);
  if (unresolved && (!validSource(checkpoint.source) || !recordingSourceMatches(recording, checkpoint.source))) {
    throw recoveryRequired("This recording differs from its unresolved upload source, or the earlier source identity is missing.");
  }
  if (unresolved && checkpoint.youtubeVideoId) {
    throw recoveryRequired("This recording already has a YouTube upload awaiting archive recovery.");
  }
  const expectedCopyPath = buildTrack1UploadCopyPath(recording, cacheRoot);
  const preparedUploadCopy = unresolved ? checkpoint.preparedUploadCopy || null : null;
  if (preparedUploadCopy && (
    !samePath(preparedUploadCopy.path, expectedCopyPath) ||
    !samePath(preparedUploadCopy.originalPath, recording.path) ||
    !samePath(preparedUploadCopy.uploadCopyManifestPath, `${preparedUploadCopy.path}.json`)
  )) {
    throw recoveryRequired("The unresolved upload is pinned to a different or unverifiable prepared-media location.");
  }
  const expectedNames = new Set([normalizedName(expectedCopyPath)]);
  if (unresolved) {
    expectedNames.add(normalizedName(buildTrack1UploadCopyPath({ ...checkpoint.source, path: recording.path }, cacheRoot)));
  }
  const sessions = await readSessionPaths(sessionDirectory, { maxEntries, maxSessionBytes });
  for (const sourcePath of sessions) {
    if (expectedNames.has(normalizedName(sourcePath)) && !samePath(sourcePath, expectedCopyPath)) {
      throw recoveryRequired("An earlier upload still references prepared media in a different cache location.");
    }
  }
  return { expectedCopyPath, preparedUploadCopy };
};
