import fs from "node:fs/promises";
import path from "node:path";
import { buildTrack1UploadCopyPath } from "./pipeline_upload_copy.mjs";

const samePath = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};

export const releaseUploadArtifacts = async ({ checkpoint, recording, sessionStore, removeCopy }) => {
  if (!["completed", "ignored_short_uploaded", "skipped_manual"].includes(checkpoint?.status)) return false;
  if (checkpoint.status === "skipped_manual") {
    const session = await sessionStore.load();
    // A skipped final request may already have created a video. Preserve all
    // evidence until that remote result is resolved explicitly.
    if (session?.finalAttempted !== false) return false;
  }
  await removeCopy(recording);
  await sessionStore.save(null);
  return true;
};

export const findVerifiedUploadCopy = async (recordingPath, checkpoint, cacheRoot) => {
  const source = checkpoint?.source;
  if (!Number.isFinite(source?.size) || !Number.isFinite(source?.modifiedAtMs)) return null;
  const outputPath = buildTrack1UploadCopyPath({ ...source, path: recordingPath }, cacheRoot);
  const manifestPath = `${outputPath}.json`;
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
  if (manifest?.version !== 1 || !samePath(manifest.source?.path, recordingPath) ||
      manifest.source?.size !== source.size || manifest.source?.modifiedAtMs !== source.modifiedAtMs) return null;
  const stat = await fs.stat(outputPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat && (!stat.isFile() || stat.size !== manifest.output?.size || stat.mtimeMs !== manifest.output?.modifiedAtMs ||
      stat.ctimeMs !== manifest.output?.changedAtMs)) return null;
  return {
    path: outputPath, originalPath: recordingPath, uploadCopyManifestPath: manifestPath,
    generatedForYouTubeUploadOnly: true,
  };
};
