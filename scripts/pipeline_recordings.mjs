const TERMINAL_STATUSES = new Set(["completed", "ignored_short", "ignored_short_uploaded", "skipped_manual"]);

export const recordingSourceIdentity = (recording) => ({
  size: Number(recording.size),
  modifiedAtMs: Number(recording.modifiedAtMs ?? recording.mtimeMs),
});

export const recordingSourceMatches = (recording, source) => {
  const left = recordingSourceIdentity(recording);
  const right = recordingSourceIdentity(source || {});
  return Number.isFinite(left.size) && Number.isFinite(left.modifiedAtMs) &&
    left.size === right.size && left.modifiedAtMs === right.modifiedAtMs;
};

export const isRecordingPending = (recording, entry) => {
  // Uploaded checkpoints must finish recovery before the source is considered again.
  if (entry?.youtubeVideoId && entry?.pendingVodEntry) return false;
  if (entry?.status === "processing") return false;
  if (!TERMINAL_STATUSES.has(entry?.status)) return true;
  // Preserve old completed markers, which have no source fingerprint.
  return Boolean(entry?.source) && !recordingSourceMatches(recording, entry.source);
};

export const planRecordingUploads = async ({ recordings, maxUploads, minimumDurationSeconds, probeRecording, matchVod, verifyRecording, activeStream }) => {
  const uploads = [];
  const skipped = [];
  const limit = Math.max(1, Math.floor(Number(maxUploads) || 1));
  for (const source of recordings) {
    if (uploads.length >= limit) break;
    const recording = await probeRecording(source);
    if (!Number.isFinite(recording?.durationSeconds) || recording.durationSeconds <= 0) {
      skipped.push({ recording: source, reason: "duration_unavailable" });
      continue;
    }
    if (verifyRecording && !(await verifyRecording(recording))) {
      skipped.push({ recording, reason: "source_changed" });
      continue;
    }
    if (recording.durationSeconds < minimumDurationSeconds) {
      skipped.push({ recording, reason: "short", terminalStatus: "ignored_short" });
      continue;
    }
    const twitchVod = matchVod(recording);
    if (!twitchVod) {
      skipped.push({ recording, reason: "unmatched" });
      continue;
    }
    if (activeStream?.id && String(twitchVod.stream_id || "") === String(activeStream.id)) {
      skipped.push({ recording, reason: "stream_live" });
      continue;
    }
    uploads.push({ recording, twitchVod });
  }
  return { uploads, skipped };
};
