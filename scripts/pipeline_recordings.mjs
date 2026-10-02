const TERMINAL_STATUSES = new Set(["completed", "ignored_short", "ignored_short_uploaded", "skipped_manual"]);

const numericIdentity = (value) => value == null || value === "" ? NaN : Number(value);
export const recordingSourceIdentity = (recording = {}) => {
  const identity = {
    size: numericIdentity(recording.size),
    modifiedAtMs: numericIdentity(recording.modifiedAtMs ?? recording.mtimeMs),
  };
  const changedAtMs = numericIdentity(recording.changedAtMs ?? recording.ctimeMs);
  if (Number.isFinite(changedAtMs)) identity.changedAtMs = changedAtMs;
  for (const [key, alias] of [["fileId", "ino"], ["deviceId", "dev"]]) {
    const value = recording[key] ?? recording[alias];
    if (value != null && value !== "") identity[key] = String(value);
  }
  return identity;
};

export const recordingSourceMatches = (recording, source) => {
  const left = recordingSourceIdentity(recording);
  const right = recordingSourceIdentity(source || {});
  return Number.isFinite(left.size) && left.size >= 0 && Number.isFinite(left.modifiedAtMs) &&
    left.size === right.size && left.modifiedAtMs === right.modifiedAtMs &&
    ["changedAtMs", "fileId", "deviceId"].every((key) =>
      left[key] == null || right[key] == null || left[key] === right[key]);
};

// A later OBS segment can be closer to the next stream's start while most of
// its footage still belongs to the earlier stream. Actual overlap takes priority.
export const selectMatchingTwitchVod = (recording, vods, { expectedUserId, expectedLogin } = {}) => {
  const start = numericIdentity(recording.startAtMs);
  const end = numericIdentity(recording.endAtMs ?? recording.modifiedAtMs);
  if (!Number.isFinite(end)) return null;
  const hasStart = Number.isFinite(start);
  if (hasStart && start >= end) return null;
  const candidates = [];
  for (const vod of vods) {
    if (!vod?.id || (vod.type && vod.type !== "archive")) continue;
    if (expectedUserId != null && String(vod.user_id || "") !== String(expectedUserId)) continue;
    if (expectedLogin && vod.user_login && String(vod.user_login).toLowerCase() !== String(expectedLogin).toLowerCase()) continue;
    const vodStart = Date.parse(vod.created_at);
    const duration = String(vod.duration || "").match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    const seconds = duration ? Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0) : 0;
    if (!Number.isFinite(vodStart) || !Number.isFinite(seconds) || seconds <= 0) continue;
    const vodEnd = vodStart + seconds * 1000;
    const overlap = hasStart ? Math.min(end, vodEnd) - Math.max(start, vodStart) : 0;
    if (hasStart ? overlap <= 0 : end < vodStart - 15 * 60_000 || end > vodEnd + 60 * 60_000) continue;
    candidates.push({ vod, overlap, delta: Math.abs((hasStart ? start : end) - (hasStart ? vodStart : vodEnd)) });
  }
  candidates.sort((a, b) => b.overlap - a.overlap || a.delta - b.delta);
  if (!candidates.length) return null;
  const [best, next] = candidates;
  if (next && best.overlap === next.overlap && best.delta === next.delta && String(best.vod.id) !== String(next.vod.id)) return null;
  return best.vod;
};

const overlapsActiveStream = (recording, stream) => {
  const startedAtMs = Date.parse(stream?.started_at || "");
  const endAtMs = numericIdentity(recording.endAtMs ?? recording.modifiedAtMs);
  return Number.isFinite(startedAtMs) && Number.isFinite(endAtMs) && endAtMs >= startedAtMs;
};

export const isRecordingPending = (recording, entry) => {
  // Uploaded checkpoints must finish recovery before the source is considered again.
  if (entry?.youtubeVideoId && entry?.pendingVodEntry) return false;
  if (entry?.status === "processing") return false;
  if (!TERMINAL_STATUSES.has(entry?.status)) return true;
  // Preserve old completed markers, which have no source fingerprint.
  return Boolean(entry?.source) && !recordingSourceMatches(recording, entry.source);
};

export const planRecordingUploads = async ({ recordings, maxUploads, minimumDurationSeconds, probeRecording, matchVod, verifyRecording, activeStream, signal, beforeProbe }) => {
  const uploads = [];
  const skipped = [];
  const limit = Math.max(1, Math.floor(Number(maxUploads) || 1));
  for (const source of recordings) {
    signal?.throwIfAborted();
    if (uploads.length >= limit) break;
    await beforeProbe?.(source);
    signal?.throwIfAborted();
    const recording = await probeRecording(source);
    signal?.throwIfAborted();
    if (!Number.isFinite(recording?.durationSeconds) || recording.durationSeconds <= 0) {
      skipped.push({ recording: source, reason: "duration_unavailable" });
      continue;
    }
    if (verifyRecording && !(await verifyRecording(recording))) {
      skipped.push({ recording, reason: "source_changed" });
      continue;
    }
    signal?.throwIfAborted();
    const twitchVod = await matchVod(recording);
    signal?.throwIfAborted();
    if (overlapsActiveStream(recording, activeStream) ||
        (activeStream?.id && String(twitchVod?.stream_id || "") === String(activeStream.id))) {
      skipped.push({ recording, reason: "stream_live" });
      continue;
    }
    if (recording.durationSeconds < minimumDurationSeconds) {
      skipped.push({ recording, reason: "short", terminalStatus: "ignored_short" });
      continue;
    }
    if (!twitchVod) {
      skipped.push({ recording, reason: "unmatched" });
      continue;
    }
    uploads.push({ recording, twitchVod });
  }
  return { uploads, skipped };
};
