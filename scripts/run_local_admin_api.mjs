import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");

const config = {
  host: process.env.ADMIN_API_HOST || "localhost",
  port: Number(process.env.ADMIN_API_PORT || "49721"),
  archiveSiteUrl: cleanUrl(process.env.ARCHIVE_SITE_URL || ""),
  adminPassword: String(process.env.ADMIN_PANEL_PASSWORD || ""),
  autoGitPush: (process.env.AUTO_GIT_PUSH || "true").toLowerCase() === "true",
  vodsDataPath: process.env.ARCHIVE_VODS_PATH || path.join(repoRoot, "public", "data", "vods.json"),
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  twitchUserTokenPath: process.env.TWITCH_USER_TOKEN_PATH || path.join(repoRoot, "secrets", "twitch_user_token.json"),
  youtubeClientSecretPath: process.env.YOUTUBE_CLIENT_SECRET_PATH || path.join(repoRoot, "secrets", "youtube_client_secret.json"),
  youtubeTokenPath: process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json"),
  twitchAuthRedirectHost: process.env.TWITCH_AUTH_REDIRECT_HOST || "localhost",
  twitchAuthRedirectPort: Number(process.env.TWITCH_AUTH_REDIRECT_PORT || "49724"),
  twitchAuthTimeoutSeconds: Number(process.env.TWITCH_AUTH_TIMEOUT_SECONDS || "180"),
  spotifyNoticeText: process.env.ADMIN_SPOTIFY_NOTICE_TEXT || "Spotify audio is muted on this VOD.",
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;
const sessions = new Map();
let twitchBootstrapPromise = null;
const TWITCH_AUTH_CALLBACK_PATH = "/twitch/callback";
const TWITCH_AUTH_SCOPES = ["channel:manage:videos"];

const log = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const fail = (message) => {
  throw new Error(message);
};

const openUrl = (url) => {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
};

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonFile = async (filePath, fallback) => {
  if (!(await fileExists(filePath))) return fallback;
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
};

const writeJsonFile = async (filePath, payload) => {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const getAllowedOrigins = () => {
  const defaults = new Set(["http://localhost:3000"]);
  try {
    defaults.add(new URL(config.archiveSiteUrl).origin);
  } catch {
    // ignored
  }
  return defaults;
};

const allowedOrigins = getAllowedOrigins();

const setCorsHeaders = (req, res) => {
  const origin = String(req.headers.origin || "");
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
};

const sendJson = (req, res, statusCode, payload) => {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const readBodyJson = async (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    let byteCount = 0;
    req.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", (error) => reject(error));
  });

const timingSafeEquals = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const issueSession = () => {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  return { token, expiresAt };
};

const pruneSessions = () => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) sessions.delete(token);
  }
};

const getBearerToken = (req) => {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
};

const requireSession = (req) => {
  pruneSessions();
  const token = getBearerToken(req);
  if (!token) fail("Missing admin session token");
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    fail("Admin session expired");
  }
  return token;
};

const loadVods = async () => {
  const vods = await readJsonFile(config.vodsDataPath, []);
  return Array.isArray(vods) ? vods : [];
};

const saveVods = async (vods) => {
  await writeJsonFile(config.vodsDataPath, vods);
};

const stageAndPushVodData = (commitMessage) => {
  const stage = spawnSync("git", ["add", config.vodsDataPath], { cwd: repoRoot, stdio: "inherit" });
  if (stage.status !== 0) fail("git add failed for VOD data");

  const checkDiff = spawnSync("git", ["diff", "--cached", "--quiet", "--", config.vodsDataPath], { cwd: repoRoot });
  if (checkDiff.status === 0) {
    log("No VOD data changes to commit.");
    return;
  }

  const commit = spawnSync("git", ["commit", "-m", commitMessage], { cwd: repoRoot, stdio: "inherit" });
  if (commit.status !== 0) fail("git commit failed");

  if (!config.autoGitPush) return;
  const push = spawnSync("git", ["push", "origin", "main"], { cwd: repoRoot, stdio: "inherit" });
  if (push.status !== 0) fail("git push failed");
};

const updateVod = async (vodId, updater, commitMessage) => {
  const vods = await loadVods();
  const index = vods.findIndex((vod) => String(vod.id) === String(vodId));
  if (index < 0) fail(`VOD ${vodId} not found`);

  const updatedVod = updater({ ...vods[index] });
  updatedVod.updatedAt = new Date().toISOString();
  vods[index] = updatedVod;

  await saveVods(vods);
  stageAndPushVodData(commitMessage);
  return updatedVod;
};

const loadYoutubeClient = async () => {
  if (!(await fileExists(config.youtubeClientSecretPath))) {
    fail(`Missing YouTube OAuth client file at ${config.youtubeClientSecretPath}`);
  }
  if (!(await fileExists(config.youtubeTokenPath))) {
    fail(`Missing YouTube OAuth token at ${config.youtubeTokenPath}`);
  }

  const clientSecrets = JSON.parse(await fs.readFile(config.youtubeClientSecretPath, "utf8"));
  const details = clientSecrets.installed || clientSecrets.web;
  if (!details?.client_id || !details?.client_secret || !details?.redirect_uris?.[0]) {
    fail("Invalid YouTube OAuth client secret JSON");
  }

  const token = JSON.parse(await fs.readFile(config.youtubeTokenPath, "utf8"));
  const authClient = new google.auth.OAuth2(details.client_id, details.client_secret, details.redirect_uris[0]);
  authClient.setCredentials(token);
  return google.youtube({ version: "v3", auth: authClient });
};

const setYouTubeVideoPrivate = async (youtube, videoId) => {
  const response = await youtube.videos.list({
    part: ["status"],
    id: [videoId],
  });
  const item = response.data.items?.[0];
  if (!item) fail(`YouTube video not found: ${videoId}`);

  const currentPrivacy = item.status?.privacyStatus || "unknown";
  if (currentPrivacy === "private") return { id: videoId, privacyStatus: "private", changed: false };

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: {
        privacyStatus: "private",
        ...(item.status?.selfDeclaredMadeForKids !== undefined
          ? { selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids }
          : {}),
      },
    },
  });

  return { id: videoId, privacyStatus: "private", changed: true };
};

const saveTwitchTokenRecord = async (tokenRecord) => {
  await writeJsonFile(config.twitchUserTokenPath, tokenRecord);
};

const refreshTwitchUserToken = async (refreshToken) => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Failed to refresh Twitch token (${response.status}): ${body}`);
  }

  return response.json();
};

const validateTwitchToken = async (accessToken) => {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    method: "GET",
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Failed to validate Twitch token (${response.status}): ${body}`);
  }

  return response.json();
};

const ensureTwitchLoginMatches = (login) => {
  if (!config.twitchChannelLogin) return;
  if (!login) return;
  if (String(login).toLowerCase() !== String(config.twitchChannelLogin).toLowerCase()) {
    fail(`Twitch token login "${login}" does not match TWITCH_CHANNEL_LOGIN "${config.twitchChannelLogin}"`);
  }
};

const persistValidatedTwitchToken = async (tokenPayload, existingRecord = {}) => {
  const accessToken = tokenPayload?.access_token || existingRecord?.access_token;
  if (!accessToken) fail("Twitch OAuth payload missing access_token");

  const validated = await validateTwitchToken(accessToken);
  ensureTwitchLoginMatches(validated.login);

  const expiresInSeconds = Number(tokenPayload?.expires_in || 0);
  const expiresAtMs =
    expiresInSeconds > 0
      ? Date.now() + expiresInSeconds * 1000
      : Number(existingRecord.expires_at_ms || 0) || Date.now() + 3600 * 1000;

  const record = {
    ...existingRecord,
    ...tokenPayload,
    access_token: accessToken,
    refresh_token: tokenPayload?.refresh_token || existingRecord?.refresh_token || "",
    expires_at_ms: expiresAtMs,
    obtained_at: new Date().toISOString(),
    user_id: validated.user_id,
    user_login: validated.login,
    scopes: validated.scopes || tokenPayload?.scope || existingRecord?.scopes || [],
  };

  await saveTwitchTokenRecord(record);
  return record;
};

const exchangeTwitchCodeForToken = async (code, redirectUri) => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Twitch OAuth token exchange failed (${response.status}): ${body}`);
  }

  return response.json();
};

const runInteractiveTwitchAuth = async () =>
  new Promise((resolve, reject) => {
    const state = crypto.randomUUID();
    const redirectUri = `http://${config.twitchAuthRedirectHost}:${config.twitchAuthRedirectPort}${TWITCH_AUTH_CALLBACK_PATH}`;
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", config.twitchClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", TWITCH_AUTH_SCOPES.join(" "));
    authUrl.searchParams.set("force_verify", "true");
    authUrl.searchParams.set("state", state);

    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      server.close(() => {
        if (error) reject(error);
        else resolve(value);
      });
    };

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || "/", `http://${config.twitchAuthRedirectHost}:${config.twitchAuthRedirectPort}`);
        if (requestUrl.pathname !== TWITCH_AUTH_CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const oauthError = requestUrl.searchParams.get("error");
        const oauthDescription = requestUrl.searchParams.get("error_description");
        if (oauthError) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Twitch authorization failed. You can close this tab.");
          finish(new Error(`Twitch OAuth error: ${oauthError}${oauthDescription ? ` (${oauthDescription})` : ""}`));
          return;
        }

        const returnedState = requestUrl.searchParams.get("state");
        const code = requestUrl.searchParams.get("code");
        if (!returnedState || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Invalid Twitch authorization state.");
          finish(new Error("Twitch OAuth state mismatch"));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing Twitch authorization code.");
          finish(new Error("Twitch OAuth callback missing code"));
          return;
        }

        const tokenPayload = await exchangeTwitchCodeForToken(code, redirectUri);
        const saved = await persistValidatedTwitchToken(tokenPayload, {});
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Twitch authorization completed. You can close this tab.");
        finish(null, saved);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Twitch authorization failed.");
        finish(error);
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Twitch authorization. Please retry."));
    }, Math.max(30, config.twitchAuthTimeoutSeconds) * 1000);

    server.listen(config.twitchAuthRedirectPort, config.twitchAuthRedirectHost, () => {
      log(`Starting Twitch OAuth in browser for ${config.twitchChannelLogin || "configured channel"}...`);
      openUrl(authUrl.toString());
    });
  });

const seedTwitchTokenFromEnv = async () => {
  const accessToken = String(process.env.TWITCH_USER_ACCESS_TOKEN || "").trim();
  if (!accessToken) return null;

  const seeded = {
    access_token: accessToken,
    refresh_token: String(process.env.TWITCH_USER_REFRESH_TOKEN || "").trim(),
    expires_in: Number(process.env.TWITCH_USER_EXPIRES_IN || 0),
  };

  log("Seeding Twitch user token from environment variables.");
  return persistValidatedTwitchToken(seeded, {});
};

const bootstrapTwitchUserToken = async () => {
  if (twitchBootstrapPromise) return twitchBootstrapPromise;
  twitchBootstrapPromise = (async () => {
    const fromEnv = await seedTwitchTokenFromEnv();
    if (fromEnv) return fromEnv;

    log("No stored Twitch user token found. Starting one-time interactive Twitch authorization.");
    return runInteractiveTwitchAuth();
  })();

  try {
    return await twitchBootstrapPromise;
  } finally {
    twitchBootstrapPromise = null;
  }
};

const loadTwitchTokenRecord = async () => {
  if (await fileExists(config.twitchUserTokenPath)) {
    return readJsonFile(config.twitchUserTokenPath, {});
  }
  return bootstrapTwitchUserToken();
};

const refreshAndPersistTwitchToken = async (tokenRecord) => {
  const refreshToken = tokenRecord?.refresh_token || "";
  if (!refreshToken) return null;

  const refreshed = await refreshTwitchUserToken(refreshToken);
  return persistValidatedTwitchToken(
    {
      ...refreshed,
      refresh_token: refreshed.refresh_token || refreshToken,
    },
    tokenRecord
  );
};

const getValidTwitchToken = async () => {
  if (!config.twitchClientId || !config.twitchClientSecret) {
    fail("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set");
  }

  let tokenRecord = await loadTwitchTokenRecord();
  let accessToken = tokenRecord.access_token || "";
  const expiresAt = Number(tokenRecord.expires_at_ms || 0);
  const isExpired = !accessToken || !expiresAt || Date.now() >= expiresAt - 60 * 1000;

  if (isExpired) {
    const refreshed = await refreshAndPersistTwitchToken(tokenRecord);
    tokenRecord = refreshed || (await bootstrapTwitchUserToken());
    accessToken = tokenRecord.access_token || "";
  }

  try {
    const validated = await validateTwitchToken(accessToken);
    ensureTwitchLoginMatches(validated.login);
    return {
      ...tokenRecord,
      user_id: validated.user_id,
      user_login: validated.login,
      scopes: validated.scopes || tokenRecord.scopes || [],
    };
  } catch {
    const refreshed = await refreshAndPersistTwitchToken(tokenRecord);
    tokenRecord = refreshed || (await bootstrapTwitchUserToken());
    return tokenRecord;
  }
};

const deleteTwitchVod = async (vodId) => {
  const tokenRecord = await getValidTwitchToken();
  const accessToken = tokenRecord.access_token;
  const request = async (token) =>
    fetch(`https://api.twitch.tv/helix/videos?id=${encodeURIComponent(String(vodId))}`, {
      method: "DELETE",
      headers: {
        "Client-Id": config.twitchClientId,
        Authorization: `Bearer ${token}`,
      },
    });

  let response = await request(accessToken);
  if (response.status === 401 && tokenRecord.refresh_token) {
    const refreshed = await refreshTwitchUserToken(tokenRecord.refresh_token);
    const refreshedExpiresAt = Date.now() + Number(refreshed.expires_in || 0) * 1000;
    const nextRecord = {
      ...tokenRecord,
      ...refreshed,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokenRecord.refresh_token,
      expires_at_ms: refreshedExpiresAt,
      obtained_at: new Date().toISOString(),
    };
    await saveTwitchTokenRecord(nextRecord);
    response = await request(nextRecord.access_token);
  }

  if (!response.ok) {
    const body = await response.text();
    fail(`Twitch VOD delete failed (${response.status}): ${body}`);
  }

  return { id: String(vodId), deleted: true };
};

const parseVodRoute = (pathname) => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "vods") return null;
  return {
    vodId: decodeURIComponent(parts[1]),
    action: parts[2],
  };
};

const validateConfig = async () => {
  if (!config.adminPassword) fail("ADMIN_PANEL_PASSWORD is required in .env.local");
  if (!config.twitchClientId || !config.twitchClientSecret) fail("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required in .env.local");
  await ensureDirectory(path.dirname(config.vodsDataPath));
};

const sortVodsDesc = (vods) =>
  [...vods].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

const handleRequest = async (req, res) => {
  const method = req.method || "GET";
  const requestUrl = new URL(req.url || "/", `http://${config.host}:${config.port}`);
  const pathname = requestUrl.pathname;

  if (method === "OPTIONS") {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/health") {
    sendJson(req, res, 200, { ok: true, service: "soft-admin-api" });
    return;
  }

  if (method === "POST" && pathname === "/auth") {
    const body = await readBodyJson(req);
    if (!timingSafeEquals(body.password || "", config.adminPassword)) {
      sendJson(req, res, 401, { error: "Invalid admin password" });
      return;
    }
    const session = issueSession();
    sendJson(req, res, 200, { token: session.token, expiresAt: session.expiresAt });
    return;
  }

  if (method === "GET" && pathname === "/session") {
    requireSession(req);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/vods") {
    requireSession(req);
    const vods = await loadVods();
    sendJson(req, res, 200, { vods: sortVodsDesc(vods) });
    return;
  }

  const vodRoute = parseVodRoute(pathname);
  if (vodRoute && method === "POST") {
    requireSession(req);

    if (vodRoute.action === "notice") {
      const body = await readBodyJson(req);
      const enabled = Boolean(body.enabled);
      const updatedVod = await updateVod(
        vodRoute.vodId,
        (vod) => {
          if (enabled) vod.vodNotice = config.spotifyNoticeText;
          else delete vod.vodNotice;
          return vod;
        },
        `chore: ${enabled ? "enable" : "disable"} spotify notice for vod ${vodRoute.vodId}`
      );
      sendJson(req, res, 200, { vod: updatedVod });
      return;
    }

    if (vodRoute.action === "chat-replay") {
      const body = await readBodyJson(req);
      const available = Boolean(body.available);
      const updatedVod = await updateVod(
        vodRoute.vodId,
        (vod) => {
          vod.chatReplayAvailable = available;
          return vod;
        },
        `chore: set chat replay ${available ? "available" : "unavailable"} for vod ${vodRoute.vodId}`
      );
      sendJson(req, res, 200, { vod: updatedVod });
      return;
    }

    if (vodRoute.action === "unpublish") {
      const vods = await loadVods();
      const vod = vods.find((entry) => String(entry.id) === String(vodRoute.vodId));
      if (!vod) fail(`VOD ${vodRoute.vodId} not found`);

      const youtubeIds = (Array.isArray(vod.youtube) ? vod.youtube : []).map((entry) => entry?.id).filter(Boolean);
      const youtube = await loadYoutubeClient();
      const youtubeResults = [];
      for (const videoId of youtubeIds) {
        youtubeResults.push(await setYouTubeVideoPrivate(youtube, videoId));
      }

      const twitchResult = await deleteTwitchVod(vodRoute.vodId);

      const updatedVod = await updateVod(
        vodRoute.vodId,
        (entry) => ({
          ...entry,
          unpublished: true,
        }),
        `chore: unpublish vod ${vodRoute.vodId}`
      );

      sendJson(req, res, 200, {
        vod: updatedVod,
        result: {
          youtube: youtubeResults,
          twitch: twitchResult,
        },
      });
      return;
    }
  }

  sendJson(req, res, 404, { error: "Not found" });
};

await validateConfig();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log(`Request failed: ${error.message}`);
    sendJson(req, res, 500, { error: error.message });
  });
});

server.listen(config.port, config.host, () => {
  log(`Soft admin API listening on http://${config.host}:${config.port}`);
});

setInterval(pruneSessions, 60 * 1000).unref();
