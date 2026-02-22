const DEFAULT_ALLOWED_ORIGINS = [
  "https://softu.one",
  "https://www.softu.one",
  "https://softlynn.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

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
    "Access-Control-Allow-Headers": "Content-Type",
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

const parseVodIdFromPath = (pathname) => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return "";
  if (segments[0] !== "v1" || segments[1] !== "reactions") return "";
  return decodeURIComponent(segments[2] || "");
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

const handleHealth = async (request, env) => {
  ensureDb(env);
  await env.DB.prepare("SELECT 1").first();
  return json(request, env, { ok: true, service: "softu-reactions-api" });
};

const handleGet = async (request, env, vodId) => {
  const snapshot = await getReaction(env, vodId);
  return json(request, env, snapshot);
};

const handlePost = async (request, env, vodId) => {
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

      if ((url.pathname === "/health" || url.pathname === "/v1/reactions/_health") && request.method === "GET") {
        return await handleHealth(request, env);
      }

      ensureDb(env);

      const vodId = sanitizeVodId(parseVodIdFromPath(url.pathname));
      if (!vodId) {
        return json(request, env, { error: "Not found" }, 404);
      }

      if (request.method === "GET") {
        return await handleGet(request, env, vodId);
      }

      if (request.method === "POST") {
        return await handlePost(request, env, vodId);
      }

      return json(request, env, { error: "Method not allowed" }, 405);
    } catch (error) {
      console.error("softu-reactions-api error:", error);
      return json(request, env, { error: "Internal server error" }, 500);
    }
  },
};
