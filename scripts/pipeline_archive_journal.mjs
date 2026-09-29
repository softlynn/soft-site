import { recordingSourceIdentity } from "./pipeline_recordings.mjs";

export const makeUploadedCheckpoint = ({ recording, vodEntry, youtubeVideoId, partNumber }) => {
  if (!youtubeVideoId) throw new Error("Cannot checkpoint an upload without a YouTube video ID.");
  const pendingVodEntry = structuredClone(vodEntry);
  pendingVodEntry.youtube = (pendingVodEntry.youtube || []).filter((part) => String(part.id) !== String(youtubeVideoId));
  pendingVodEntry.youtube.push({
    id: String(youtubeVideoId), type: "vod", part: partNumber,
    duration: Math.max(0, Math.floor(recording.durationSeconds || 0)),
    thumbnail_url: pendingVodEntry.thumbnail_url || "",
  });
  return {
    status: "uploaded", youtubeVideoId: String(youtubeVideoId), twitchVodId: String(vodEntry.id),
    part: partNumber, source: recordingSourceIdentity(recording),
    uploadedAt: new Date().toISOString(), pendingVodEntry,
  };
};

const mergeCheckpointVod = (vods, pending) => {
  const existing = vods.find((vod) => String(vod.id) === String(pending.id));
  if (!existing) return structuredClone(pending);
  const parts = new Map((existing.youtube || []).map((part) => [String(part.id), part]));
  for (const part of pending.youtube || []) {
    const previous = parts.get(String(part.id));
    // Preserve the latest index fields when replaying an already saved part.
    parts.set(String(part.id), previous ? { ...part, ...previous } : part);
  }
  return { ...pending, ...existing, youtube: [...parts.values()].sort((a, b) => (a.part || 0) - (b.part || 0)) };
};

// Recovery must not replay publication decisions made before an admin edit or
// an archive merge. Existing remote IDs remain under their current owner and
// retain their external privacy; only a genuinely new part is finalized.
export const finalizeRecoveredUpload = async ({
  checkpoint, readLatestVods, fetchDetails, setPrivacy, syncMetadata, configuredPrivacy = "private",
}) => {
  const videoId = String(checkpoint.youtubeVideoId);
  const pending = checkpoint.pendingVodEntry;
  const pendingPart = pending?.youtube?.find((part) => String(part.id) === videoId);
  if (!pendingPart) throw new Error("Saved upload checkpoint is missing its returned video part.");
  let details = {};
  let retainUnpublished = false;
  const latestContext = async () => {
    const latestVods = await readLatestVods();
    if (!Array.isArray(latestVods)) throw new Error("Archive database must contain a JSON array.");
    const owner = latestVods.find((entry) => (entry.youtube || []).some((part) => String(part.id) === videoId));
    if (owner) return { latestVods, vodEntry: structuredClone(owner), existing: true };
    // A checkpoint can contain old siblings. Replaying it only adds the video
    // that this checkpoint owns, never parts since removed or moved by admin.
    const recoveredPart = { ...pendingPart };
    if (details.durationSeconds > 0) recoveredPart.duration = details.durationSeconds;
    if (details.thumbnailUrl) recoveredPart.thumbnail_url = details.thumbnailUrl;
    const vodEntry = mergeCheckpointVod(latestVods, { ...pending, youtube: [recoveredPart] });
    const unpublished = retainUnpublished || vodEntry.unpublished === true || recoveredPart.unpublished === true;
    if (unpublished) vodEntry.youtube.find((part) => String(part.id) === videoId).unpublished = true;
    return { latestVods, vodEntry, existing: false, unpublished };
  };
  let context = await latestContext();
  if (context.existing) return context;
  details = (await fetchDetails(videoId)) || {};
  // Fetching remote details may have taken long enough for an admin action.
  context = await latestContext();
  if (context.existing) return context;
  retainUnpublished = context.unpublished;
  const privacy = context.unpublished ? "private" : String(configuredPrivacy || "private").trim().toLowerCase() || "private";
  const applyPrivacy = async (value) => {
    if ((await setPrivacy(videoId, value)) !== true) throw new Error(`Uploaded video ${videoId} is not available for privacy finalization yet; it will be retried.`);
  };
  await applyPrivacy(privacy);
  await syncMetadata(context.vodEntry);
  context = await latestContext();
  if (context.existing) return context;
  if (context.unpublished && privacy !== "private") {
    retainUnpublished = true;
    await applyPrivacy("private");
    // Preserve admin edits made while the corrective request was in flight.
    context = await latestContext();
  }
  // Network changes and archive writes cannot form one atomic transaction.
  // These bounded rereads cover changes during finalization without holding a
  // shared archive lock across external requests. The store merges later edits.
  return context;
};

export const completeUploadedRecording = async ({ state, recordingPath, vodEntry, vods, persistVods, persistState }) => {
  const index = vods.findIndex((vod) => String(vod.id) === String(vodEntry.id));
  if (index < 0) vods.push(vodEntry);
  else vods[index] = vodEntry;
  vods.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  // The checkpoint remains recoverable if writing the index fails or the process exits.
  await persistVods(vods);
  const { pendingVodEntry: _pending, error: _error, ...checkpoint } = state.processedFiles[recordingPath];
  state.processedFiles[recordingPath] = { ...checkpoint, status: "completed", processedAt: new Date().toISOString() };
  await persistState();
};

export const recoverUploadedRecordings = async ({ state, vods, finalizeUpload, persistVods, persistState }) => {
  let recovered = 0;
  for (const [recordingPath, checkpoint] of Object.entries(state.processedFiles || {})) {
    if (!checkpoint?.youtubeVideoId || !checkpoint?.pendingVodEntry) continue;
    let vodEntry = mergeCheckpointVod(vods, { ...checkpoint.pendingVodEntry,
      youtube: (checkpoint.pendingVodEntry.youtube || []).filter((part) => String(part.id) === String(checkpoint.youtubeVideoId)),
    });
    const finalized = finalizeUpload ? await finalizeUpload(checkpoint, vodEntry) : null;
    if (finalized) {
      if (!Array.isArray(finalized.latestVods) || !finalized.vodEntry) throw new Error("Upload recovery must return the current archive and recovered VOD.");
      vods.splice(0, vods.length, ...finalized.latestVods);
      vodEntry = finalized.vodEntry;
    }
    await completeUploadedRecording({ state, recordingPath, vodEntry, vods, persistVods, persistState });
    recovered++;
  }
  return recovered;
};

export const finalizeAndCompleteUploadedRecording = async ({
  state, recordingPath, vods, persistVods, persistState, ...finalization
}) => {
  const finalized = await finalizeRecoveredUpload({ ...finalization, checkpoint: state.processedFiles[recordingPath] });
  vods.splice(0, vods.length, ...finalized.latestVods);
  await completeUploadedRecording({ state, recordingPath, vodEntry: finalized.vodEntry, vods, persistVods, persistState });
  return finalized.vodEntry;
};
