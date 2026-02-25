const deriveUploadsApiBase = () => {
  const explicitBase = String(process.env.REACT_APP_UPLOADS_API_BASE || "").trim().replace(/\/+$/, "");
  if (explicitBase) return explicitBase;

  const reactionsBase = String(process.env.REACT_APP_REACTIONS_API_BASE || "").trim().replace(/\/+$/, "");
  if (reactionsBase) return reactionsBase.replace(/\/v1\/reactions$/i, "/v1/uploads");

  return "";
};

export const UPLOADS_API_BASE = deriveUploadsApiBase();

const toFiniteNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const normalizeUpload = (item) => {
  if (!item || typeof item !== "object") return null;

  const sessionId = String(item.sessionId || item.session_id || "").trim();
  const state = String(item.state || "").trim().toLowerCase();
  if (!sessionId || !state) return null;

  return {
    sessionId,
    state,
    twitchVodId: String(item.twitchVodId || item.twitch_vod_id || "").trim() || null,
    partNumber: toFiniteNumberOrNull(item.partNumber ?? item.part_number),
    title: String(item.title || "").trim() || null,
    recordingName: String(item.recordingName || item.recording_name || "").trim() || null,
    streamDate: String(item.streamDate || item.stream_date || "").trim() || null,
    message: String(item.message || "").trim() || null,
    percent: toFiniteNumberOrNull(item.percent),
    uploadedBytes: toFiniteNumberOrNull(item.uploadedBytes ?? item.uploaded_bytes),
    totalBytes: toFiniteNumberOrNull(item.totalBytes ?? item.total_bytes),
    youtubeVideoId: String(item.youtubeVideoId || item.youtube_video_id || "").trim() || null,
    createdAtMs: toFiniteNumberOrNull(item.createdAtMs ?? item.created_at_ms),
    updatedAtMs: toFiniteNumberOrNull(item.updatedAtMs ?? item.updated_at_ms),
  };
};

export const fetchActiveVodUploads = async ({ signal } = {}) => {
  if (!UPLOADS_API_BASE) return [];

  const controller = signal ? null : new AbortController();
  const activeSignal = signal || controller.signal;
  let timeoutHandle = null;

  if (!signal) {
    timeoutHandle = setTimeout(() => controller.abort(), 5000);
  }

  try {
    const response = await fetch(`${UPLOADS_API_BASE}/active`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: activeSignal,
    });

    if (!response.ok) {
      throw new Error(`Upload status API read failed (${response.status})`);
    }

    const body = await response.json();
    const uploads = Array.isArray(body?.uploads) ? body.uploads : [];
    return uploads.map(normalizeUpload).filter(Boolean);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};
