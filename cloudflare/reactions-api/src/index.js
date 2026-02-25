const DEFAULT_ALLOWED_ORIGINS = [
  "https://softu.one",
  "https://www.softu.one",
  "https://softlynn.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const UPLOAD_ACTIVE_STATES = new Set(["preparing", "uploading", "finalizing"]);
const UPLOAD_VISIBLE_STATES = new Set(["preparing", "uploading", "finalizing", "done", "error"]);

const allowedOriginsFromEnv = (env) =>
  String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const buildCorsHeaders = (request, env) => {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...allowedOriginsFromEnv(env)]);

  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Upload-Status-Secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
};

const json = (request, env, body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...buildCorsHeaders(request, env),
      ...extraHeaders,
    },
  });

const normalizeVote = (vote) => (vote === "like" || vote === "dislike" ? vote : null);

const sanitizeVodId = (vodId) => {
  const value = String(vodId || "").trim();
  if (!value || value.length > 128) return "";
  return value;
};

const sanitizeUploadSessionId = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200) return "";
  return normalized;
};

const sanitizeText = (value, maxLength = 512) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
};

const parseReactionsVodIdFromPath = (pathname) => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return "";
  if (segments[0] !== "v1" || segments[1] !== "reactions") return "";
  return decodeURIComponent(segments[2] || "");
};

const parseUploadsAction = (pathname) => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  if (segments[0] !== "v1" || segments[1] !== "uploads") return null;
  return segments.slice(2).map((segment) => decodeURIComponent(segment));
};

const ensureDb = (env) => {
  if (!env?.DB) {
    throw new Error("Missing D1 binding 'DB'. Update cloudflare/reactions-api/wrangler.jsonc with your database_id.");
  }
};

const reactionSnapshot = (row, vodId) => ({
  vodId,
  likes: Math.max(0, Number(row?.likes) || 0),
  dislikes: Math.max(0, Number(row?.dislikes) || 0),
  updatedAt: row?.updated_at || null,
});

const getVoteDelta = (previousVote, nextVote) => {
  let likeDelta = 0;
  let dislikeDelta = 0;

  if (previousVote === "like" && nextVote !== "like") likeDelta -= 1;
  if (previousVote === "dislike" && nextVote !== "dislike") dislikeDelta -= 1;
  if (nextVote === "like" && previousVote !== "like") likeDelta += 1;
  if (nextVote === "dislike" && previousVote !== "dislike") dislikeDelta += 1;

  return { likeDelta, dislikeDelta };
};

const getReaction = async (env, vodId) => {
  const row = await env.DB.prepare("SELECT vod_id, likes, dislikes, updated_at FROM vod_reactions WHERE vod_id = ?1")
    .bind(vodId)
    .first();
  return reactionSnapshot(row, vodId);
};

const applyReaction = async (env, vodId, previousVote, nextVote) => {
  const { likeDelta, dislikeDelta } = getVoteDelta(previousVote, nextVote);

  await env.DB.prepare(
    "INSERT INTO vod_reactions (vod_id, likes, dislikes, updated_at) VALUES (?1, 0, 0, CURRENT_TIMESTAMP) ON CONFLICT(vod_id) DO NOTHING"
  )
    .bind(vodId)
    .run();

  await env.DB.prepare(
    "UPDATE vod_reactions SET likes = MAX(0, likes + ?1), dislikes = MAX(0, dislikes + ?2), updated_at = CURRENT_TIMESTAMP WHERE vod_id = ?3"
  )
    .bind(likeDelta, dislikeDelta, vodId)
    .run();

  return getReaction(env, vodId);
};

const uploadSessionSnapshot = (row) => ({
  sessionId: row?.session_id || null,
  twitchVodId: row?.twitch_vod_id || null,
  partNumber: Number(row?.part_number || 0) || null,
  title: row?.title || null,
  recordingName: row?.recording_name || null,
  streamDate: row?.stream_date || null,
  state: row?.state || null,
  message: row?.message || null,
  percent: Number.isFinite(Number(row?.percent)) ? Number(row.percent) : null,
  uploadedBytes: Number.isFinite(Number(row?.uploaded_bytes)) ? Number(row.uploaded_bytes) : null,
  totalBytes: Number.isFinite(Number(row?.total_bytes)) ? Number(row.total_bytes) : null,
  youtubeVideoId: row?.youtube_video_id || null,
  createdAtMs: Number.isFinite(Number(row?.created_at_ms)) ? Number(row.created_at_ms) : null,
  updatedAtMs: Number.isFinite(Number(row?.updated_at_ms)) ? Number(row.updated_at_ms) : null,
  expiresAtMs: Number.isFinite(Number(row?.expires_at_ms)) ? Number(row.expires_at_ms) : null,
});

const requireUploadWriteSecret = (request, env) => {
  const expected = String(env?.UPLOAD_STATUS_WRITE_SECRET || "").trim();
  if (!expected) {
    throw new Error("Missing Worker secret UPLOAD_STATUS_WRITE_SECRET");
  }
  const provided = String(request.headers.get("X-Upload-Status-Secret") || "").trim();
  return provided && provided === expected;
};

const parseFiniteNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const computeUploadSessionExpiry = (state, nowMs) => {
  switch (state) {
    case "preparing":
    case "uploading":
      return nowMs + 24 * 60 * 60 * 1000;
    case "finalizing":
      return nowMs + 60 * 60 * 1000;
    case "done":
      return nowMs + 15 * 60 * 1000;
    case "error":
      return nowMs + 2 * 60 * 60 * 1000;
    default:
      return nowMs + 30 * 60 * 1000;
  }
};

const upsertUploadSession = async (env, payload) => {
  const sessionId = sanitizeUploadSessionId(payload?.sessionId);
  if (!sessionId) {
    throw Object.assign(new Error("Invalid upload sessionId"), { status: 400 });
  }

  const rawState = String(payload?.state || "").trim().toLowerCase();
  if (!UPLOAD_VISIBLE_STATES.has(rawState)) {
    throw Object.assign(new Error("Invalid upload state"), { status: 400 });
  }

  const nowMs = Date.now();
  const createdAtMs = Math.max(0, Math.floor(parseFiniteNumberOrNull(payload?.createdAtMs) ?? nowMs));
  const updatedAtMs = Math.max(createdAtMs, Math.floor(parseFiniteNumberOrNull(payload?.updatedAtMs) ?? nowMs));
  const expiresAtMs = Math.max(updatedAtMs, Math.floor(parseFiniteNumberOrNull(payload?.expiresAtMs) ?? computeUploadSessionExpiry(rawState, nowMs)));

  const uploadedBytes = parseFiniteNumberOrNull(payload?.uploadedBytes);
  const totalBytes = parseFiniteNumberOrNull(payload?.totalBytes);
  const percent = parseFiniteNumberOrNull(payload?.percent);

  await env.DB.prepare(
    `INSERT INTO vod_upload_sessions (
      session_id, twitch_vod_id, part_number, title, recording_name, stream_date,
      state, message, percent, uploaded_bytes, total_bytes, youtube_video_id,
      created_at_ms, updated_at_ms, expires_at_ms
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    ON CONFLICT(session_id) DO UPDATE SET
      twitch_vod_id = COALESCE(excluded.twitch_vod_id, vod_upload_sessions.twitch_vod_id),
      part_number = COALESCE(excluded.part_number, vod_upload_sessions.part_number),
      title = COALESCE(excluded.title, vod_upload_sessions.title),
      recording_name = COALESCE(excluded.recording_name, vod_upload_sessions.recording_name),
      stream_date = COALESCE(excluded.stream_date, vod_upload_sessions.stream_date),
      state = excluded.state,
      message = COALESCE(excluded.message, vod_upload_sessions.message),
      percent = COALESCE(excluded.percent, vod_upload_sessions.percent),
      uploaded_bytes = COALESCE(excluded.uploaded_bytes, vod_upload_sessions.uploaded_bytes),
      total_bytes = COALESCE(excluded.total_bytes, vod_upload_sessions.total_bytes),
      youtube_video_id = COALESCE(excluded.youtube_video_id, vod_upload_sessions.youtube_video_id),
      updated_at_ms = excluded.updated_at_ms,
      expires_at_ms = excluded.expires_at_ms`
  )
    .bind(
      sessionId,
      sanitizeText(payload?.twitchVodId, 128),
      payload?.partNumber == null ? null : Math.max(1, Math.floor(Number(payload.partNumber) || 1)),
      sanitizeText(payload?.title, 300),
      sanitizeText(payload?.recordingName, 300),
      sanitizeText(payload?.streamDate, 64),
      rawState,
      sanitizeText(payload?.message, 400),
      percent == null ? null : Math.max(0, Math.min(100, percent)),
      uploadedBytes == null ? null : Math.max(0, Math.floor(uploadedBytes)),
      totalBytes == null ? null : Math.max(0, Math.floor(totalBytes)),
      sanitizeText(payload?.youtubeVideoId, 64),
      createdAtMs,
      updatedAtMs,
      expiresAtMs
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT session_id, twitch_vod_id, part_number, title, recording_name, stream_date, state, message,
            percent, uploaded_bytes, total_bytes, youtube_video_id, created_at_ms, updated_at_ms, expires_at_ms
       FROM vod_upload_sessions WHERE session_id = ?1`
  )
    .bind(sessionId)
    .first();

  return uploadSessionSnapshot(row);
};

const listActiveUploadSessions = async (env) => {
  const nowMs = Date.now();
  await env.DB.prepare("DELETE FROM vod_upload_sessions WHERE expires_at_ms < ?1").bind(nowMs - 60_000).run();

  const { results } = await env.DB.prepare(
    `SELECT session_id, twitch_vod_id, part_number, title, recording_name, stream_date, state, message,
            percent, uploaded_bytes, total_bytes, youtube_video_id, created_at_ms, updated_at_ms, expires_at_ms
       FROM vod_upload_sessions
      WHERE expires_at_ms >= ?1 AND state IN ('preparing','uploading','finalizing')
      ORDER BY created_at_ms DESC`
  )
    .bind(nowMs)
    .all();

  return Array.isArray(results) ? results.map(uploadSessionSnapshot) : [];
};

const handleHealth = async (request, env) => {
  ensureDb(env);
  await env.DB.prepare("SELECT 1").first();
  return json(request, env, { ok: true, service: "softu-reactions-api" });
};

const handleGetReaction = async (request, env, vodId) => {
  const snapshot = await getReaction(env, vodId);
  return json(request, env, snapshot);
};

const handlePostReaction = async (request, env, vodId) => {
  let body = null;
  try {
    body = await request.json();
  } catch {
    return json(request, env, { error: "Invalid JSON body" }, 400);
  }

  const previousVote = normalizeVote(body?.previousVote);
  const nextVote = normalizeVote(body?.nextVote);
  const snapshot = await applyReaction(env, vodId, previousVote, nextVote);
  return json(request, env, snapshot);
};

const handleUploadsActive = async (request, env) => {
  const uploads = await listActiveUploadSessions(env);
  return json(request, env, { uploads });
};

const handleUploadsReport = async (request, env) => {
  if (!requireUploadWriteSecret(request, env)) {
    return json(request, env, { error: "Unauthorized" }, 401);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return json(request, env, { error: "Invalid JSON body" }, 400);
  }

  try {
    const session = await upsertUploadSession(env, body);
    return json(request, env, { ok: true, session });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json(request, env, { error: error?.message || "Upload report failed" }, status);
  }
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: buildCorsHeaders(request, env),
        });
      }

      if ((url.pathname === "/health" || url.pathname === "/v1/reactions/_health" || url.pathname === "/v1/uploads/_health") && request.method === "GET") {
        return await handleHealth(request, env);
      }

      ensureDb(env);

      const uploadAction = parseUploadsAction(url.pathname);
      if (uploadAction) {
        if (request.method === "GET" && uploadAction.length === 1 && uploadAction[0] === "active") {
          return await handleUploadsActive(request, env);
        }
        if (request.method === "POST" && uploadAction.length === 1 && uploadAction[0] === "report") {
          return await handleUploadsReport(request, env);
        }
        return json(request, env, { error: "Not found" }, 404);
      }

      const vodId = sanitizeVodId(parseReactionsVodIdFromPath(url.pathname));
      if (!vodId) {
        return json(request, env, { error: "Not found" }, 404);
      }

      if (request.method === "GET") {
        return await handleGetReaction(request, env, vodId);
      }

      if (request.method === "POST") {
        return await handlePostReaction(request, env, vodId);
      }

      return json(request, env, { error: "Method not allowed" }, 405);
    } catch (error) {
      console.error("softu-reactions-api error:", error);
      return json(request, env, { error: "Internal server error" }, 500);
    }
  },
};
