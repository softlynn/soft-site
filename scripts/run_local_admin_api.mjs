import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_GIT_COMMIT_AUTHOR_NAME = "softu archive bot";
const DEFAULT_GIT_COMMIT_AUTHOR_EMAIL = "archive-bot@softu.one";

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");

const config = {
  host: process.env.ADMIN_API_HOST || "localhost",
  port: Number(process.env.ADMIN_API_PORT || "49731"),
  archiveSiteUrl: cleanUrl(process.env.ARCHIVE_SITE_URL || ""),
  adminAllowedOrigins: String(process.env.ADMIN_ALLOWED_ORIGINS || ""),
  adminPassword: String(process.env.ADMIN_PANEL_PASSWORD || ""),
  autoGitPush: (process.env.AUTO_GIT_PUSH || "true").toLowerCase() === "true",
  gitCommitAuthorName:
    String(process.env.GIT_COMMIT_AUTHOR_NAME || process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_COMMIT_AUTHOR_NAME).trim() ||
    DEFAULT_GIT_COMMIT_AUTHOR_NAME,
  gitCommitAuthorEmail:
    String(process.env.GIT_COMMIT_AUTHOR_EMAIL || process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_COMMIT_AUTHOR_EMAIL).trim() ||
    DEFAULT_GIT_COMMIT_AUTHOR_EMAIL,
  vodsDataPath: process.env.ARCHIVE_VODS_PATH || path.join(repoRoot, "public", "data", "vods.json"),
  siteDesignPath: process.env.SITE_DESIGN_PATH || path.join(repoRoot, "public", "data", "site-design.json"),
  designAssetsPath: process.env.SITE_DESIGN_ASSETS_PATH || path.join(repoRoot, "public", "uploads", "design"),
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  twitchUserTokenPath: process.env.TWITCH_USER_TOKEN_PATH || path.join(repoRoot, "secrets", "twitch_user_token.json"),
  youtubeClientSecretPath: process.env.YOUTUBE_CLIENT_SECRET_PATH || path.join(repoRoot, "secrets", "youtube_client_secret.json"),
  youtubeTokenPath: process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json"),
  twitchAuthTimeoutSeconds: Number(process.env.TWITCH_AUTH_TIMEOUT_SECONDS || "180"),
  adminIdleTimeoutMinutes: Number(process.env.ADMIN_API_IDLE_TIMEOUT_MINUTES || "240"),
  spotifyNoticeText: process.env.ADMIN_SPOTIFY_NOTICE_TEXT || "Spotify audio may be muted on this VOD.",
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DESIGN_ASSET_BYTES = 5 * 1024 * 1024;
const DESIGN_ASSET_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);
const sessions = new Map();
let twitchBootstrapState = null;
const TWITCH_AUTH_SCOPES = ["channel:manage:videos"];
const TWITCH_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
let lastActivityAt = Date.now();
let shuttingDownForIdle = false;
let googleApis = null;

const log = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const fail = (message) => {
  throw new Error(message);
};

const gitCommitIdentityArgs = () => [
  "-c",
  `user.name=${config.gitCommitAuthorName}`,
  "-c",
  `user.email=${config.gitCommitAuthorEmail}`,
];

const createApiError = (status, message, details = {}) => Object.assign(new Error(message), { status, ...details });

const openUrl = (url) => {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
};

const markActivity = () => {
  lastActivityAt = Date.now();
};

const getGoogleApis = async () => {
  if (googleApis) return googleApis;
  const module = await import("googleapis");
  googleApis = module.google;
  return googleApis;
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
  const defaults = new Set(["http://localhost:3000", "https://softlynn.github.io"]);
  try {
    if (config.archiveSiteUrl) defaults.add(new URL(config.archiveSiteUrl).origin);
  } catch {
    // ignored
  }
  if (config.adminAllowedOrigins) {
    for (const value of config.adminAllowedOrigins.split(",")) {
      const trimmed = value.trim();
      if (trimmed) defaults.add(trimmed);
    }
  }
  return defaults;
};

const allowedOrigins = getAllowedOrigins();
const isGithubPagesOrigin = (origin) => /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);
const isHttpOrHttpsOrigin = (origin) => /^https?:\/\/[^/]+$/i.test(origin);

const setCorsHeaders = (req, res) => {
  const origin = String(req.headers.origin || "");
  if (allowedOrigins.has(origin) || isGithubPagesOrigin(origin) || isHttpOrHttpsOrigin(origin)) {
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
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
};

const loadVods = async () => {
  const vods = await readJsonFile(config.vodsDataPath, []);
  return Array.isArray(vods) ? vods : [];
};

const saveVods = async (vods) => {
  await writeJsonFile(config.vodsDataPath, vods);
};

const loadSiteDesign = async () => {
  const design = await readJsonFile(config.siteDesignPath, {});
  return design && typeof design === "object" ? design : {};
};

const saveSiteDesign = async (design) => {
  await writeJsonFile(config.siteDesignPath, design);
};

const sanitizeAssetBaseName = (value) => {
  const rawName = path.basename(String(value || "image"));
  const withoutExtension = rawName.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "image";
};

const parseDesignAssetUpload = (body) => {
  const dataUrl = String(body?.dataUrl || "");
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw createApiError(400, "Upload must be a base64 image data URL.");

  const mimeType = String(body?.contentType || match[1] || "").toLowerCase();
  const extension = DESIGN_ASSET_EXTENSIONS.get(mimeType);
  if (!extension) throw createApiError(400, "Design images must be PNG, JPEG, WebP, or GIF.");

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw createApiError(400, "Uploaded image is empty.");
  if (buffer.length > MAX_DESIGN_ASSET_BYTES) throw createApiError(413, "Uploaded image must be 5 MB or smaller.");

  return {
    buffer,
    extension,
    baseName: sanitizeAssetBaseName(body?.fileName),
  };
};

const saveDesignAsset = async (body) => {
  const { buffer, extension, baseName } = parseDesignAssetUpload(body);
  await ensureDirectory(config.designAssetsPath);
  const fileName = `${baseName}-${Date.now().toString(36)}${extension}`;
  const filePath = path.join(config.designAssetsPath, fileName);
  await fs.writeFile(filePath, buffer);

  return {
    filePath,
    url: `/uploads/design/${fileName}`,
  };
};

const getPublishBranch = () => {
  const configured = String(process.env.GIT_PUBLISH_BRANCH || "main").trim();
  return configured || "main";
};

const toRepoRelativeGitPath = (filePath) => {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(repoRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    fail(`Cannot publish ${filePath}; it is outside the repository.`);
  }
  return relativePath.replace(/\\/g, "/");
};

const commitPathsInWorktree = (worktreeRoot, gitPaths, commitMessage, label) => {
  const stage = spawnSync("git", ["add", "--", ...gitPaths], { cwd: worktreeRoot, stdio: "inherit" });
  if (stage.status !== 0) fail(`git add failed for ${label}`);

  const checkDiff = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...gitPaths], { cwd: worktreeRoot });
  if (checkDiff.status === 0) {
    log(`No ${label} changes to commit.`);
    return false;
  }
  if (checkDiff.status !== 1) {
    fail(`git diff failed for ${label}`);
  }

  const commit = spawnSync("git", [...gitCommitIdentityArgs(), "commit", "-m", commitMessage], {
    cwd: worktreeRoot,
    stdio: "inherit",
  });
  if (commit.status !== 0) fail("git commit failed");
  return true;
};

const publishPathsFromFreshOrigin = async (paths, commitMessage, label) => {
  const sourcePaths = Array.isArray(paths) ? paths : [paths];
  const gitPaths = sourcePaths.map(toRepoRelativeGitPath);

  if (!config.autoGitPush) {
    commitPathsInWorktree(repoRoot, gitPaths, commitMessage, label);
    return;
  }

  const branch = getPublishBranch();
  const publishRoot = path.join(os.tmpdir(), `soft-site-publish-${Date.now()}-${process.pid}`);
  const fetch = spawnSync("git", ["fetch", "origin", branch], { cwd: repoRoot, stdio: "inherit" });
  if (fetch.status !== 0) fail(`git fetch origin ${branch} failed`);

  const addWorktree = spawnSync("git", ["worktree", "add", "--detach", publishRoot, `origin/${branch}`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (addWorktree.status !== 0) fail("git worktree add failed");

  try {
    for (let index = 0; index < sourcePaths.length; index += 1) {
      const targetPath = path.join(publishRoot, gitPaths[index]);
      await ensureDirectory(path.dirname(targetPath));
      await fs.copyFile(sourcePaths[index], targetPath);
    }

    const hasCommit = commitPathsInWorktree(publishRoot, gitPaths, commitMessage, label);
    if (!hasCommit) return;

    const push = spawnSync("git", ["push", "origin", `HEAD:${branch}`], { cwd: publishRoot, stdio: "inherit" });
    if (push.status !== 0) fail("git push failed");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", publishRoot], { cwd: repoRoot, stdio: "ignore" });
  }
};

const stageAndPushPaths = async (paths, commitMessage, label) => {
  const sourcePaths = Array.isArray(paths) ? paths : [paths];
  await publishPathsFromFreshOrigin(sourcePaths, commitMessage, label);
};

const stageAndPushVodData = async (commitMessage) => {
  await stageAndPushPaths(config.vodsDataPath, commitMessage, "VOD data");
};

const stageAndPushSiteDesign = async (commitMessage) => {
  await stageAndPushPaths(config.siteDesignPath, commitMessage, "site design data");
};

const updateVod = async (vodId, updater, commitMessage) => {
  const vods = await loadVods();
  const index = vods.findIndex((vod) => String(vod.id) === String(vodId));
  if (index < 0) fail(`VOD ${vodId} not found`);

  const updatedVod = updater({ ...vods[index] });
  updatedVod.updatedAt = new Date().toISOString();
  vods[index] = updatedVod;

  await saveVods(vods);
  await stageAndPushVodData(commitMessage);
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

  const google = await getGoogleApis();
  const token = JSON.parse(await fs.readFile(config.youtubeTokenPath, "utf8"));
  const authClient = new google.auth.OAuth2(details.client_id, details.client_secret, details.redirect_uris[0]);
  authClient.setCredentials(token);
  return google.youtube({ version: "v3", auth: authClient });
};

const setYouTubeVideoPrivacy = async (youtube, videoId, privacyStatus) => {
  const normalizedPrivacy = String(privacyStatus || "").trim().toLowerCase();
  if (!normalizedPrivacy) fail("YouTube privacy status is required");

  const response = await youtube.videos.list({
    part: ["status"],
    id: [videoId],
  });
  const item = response.data.items?.[0];
  if (!item) fail(`YouTube video not found: ${videoId}`);

  const currentPrivacy = item.status?.privacyStatus || "unknown";
  if (currentPrivacy === normalizedPrivacy) {
    return { id: videoId, privacyStatus: normalizedPrivacy, changed: false };
  }

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: {
        privacyStatus: normalizedPrivacy,
        ...(item.status?.selfDeclaredMadeForKids !== undefined
          ? { selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids }
          : {}),
      },
    },
  });

  return { id: videoId, privacyStatus: normalizedPrivacy, changed: true };
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

const requestTwitchDeviceCode = async () => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    scopes: TWITCH_AUTH_SCOPES.join(" "),
  });

  const response = await fetch("https://id.twitch.tv/oauth2/device", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Twitch device authorization request failed (${response.status}): ${body}`);
  }

  return response.json();
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const pollTwitchDeviceToken = async (deviceCode) => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    grant_type: TWITCH_DEVICE_GRANT_TYPE,
    device_code: String(deviceCode || ""),
  });
  if (config.twitchClientSecret) params.set("client_secret", config.twitchClientSecret);

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (response.ok) {
    return {
      status: "success",
      payload: await response.json(),
    };
  }

  const text = await response.text();
  let message = "";
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.message || parsed?.error || "");
  } catch {
    message = String(text || "");
  }

  const normalized = message.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "authorization_pending") return { status: "pending" };
  if (normalized === "slow_down") return { status: "slow_down" };
  if (normalized === "access_denied") return { status: "denied" };
  if (normalized === "expired_token" || normalized === "invalid_device_code") return { status: "expired" };

  return {
    status: "error",
    error: `Twitch device token poll failed (${response.status}): ${text}`,
  };
};

const startInteractiveTwitchAuth = async () => {
  const device = await requestTwitchDeviceCode();
  const authUrl = String(device?.verification_uri || "");
  const userCode = String(device?.user_code || "");
  const expiresInSeconds = Number(device?.expires_in || config.twitchAuthTimeoutSeconds || 1800);

  const bootstrap = {
    authUrl,
    userCode,
    done: false,
    error: null,
    startedAt: Date.now(),
    promise: null,
  };

  bootstrap.promise = (async () => {
    if (!device?.device_code) {
      fail("Twitch device authorization did not return a device_code");
    }
    if (!authUrl) {
      fail("Twitch device authorization did not return a verification URL");
    }

    let pollIntervalSeconds = Math.max(1, Number(device?.interval || 5));
    const expiresAtMs = Date.now() + Math.max(30, expiresInSeconds) * 1000;

    log(`Starting Twitch device authorization for ${config.twitchChannelLogin || "configured channel"}...`);
    log(`Open this URL and complete authorization: ${authUrl}`);
    if (userCode) log(`Use code: ${userCode}`);
    openUrl(authUrl);

    while (Date.now() < expiresAtMs) {
      markActivity();
      await sleep(pollIntervalSeconds * 1000);
      const polled = await pollTwitchDeviceToken(device.device_code);
      if (polled.status === "pending") continue;
      if (polled.status === "slow_down") {
        pollIntervalSeconds = Math.min(pollIntervalSeconds + 5, 30);
        continue;
      }
      if (polled.status === "denied") {
        fail("Twitch authorization was denied. Retry unpublish and approve access.");
      }
      if (polled.status === "expired") {
        fail("Twitch authorization expired. Retry unpublish to get a new code.");
      }
      if (polled.status === "error") {
        fail(polled.error);
      }

      const saved = await persistValidatedTwitchToken(polled.payload, {});
      markActivity();
      return saved;
    }

    fail("Timed out waiting for Twitch authorization. Please retry unpublish.");
  })()
    .then((result) => {
      bootstrap.done = true;
      bootstrap.error = null;
      return result;
    })
    .catch((error) => {
      bootstrap.done = true;
      bootstrap.error = error?.message || "Twitch authorization failed";
      throw error;
    });

  // Prevent unhandled rejections when auth is not yet awaited by a request.
  bootstrap.promise.catch((error) => {
    log(`Twitch authorization session ended with error: ${error?.message || error}`);
  });

  return bootstrap;
};

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
  const fromEnv = await seedTwitchTokenFromEnv();
  if (fromEnv) return fromEnv;

  if (!twitchBootstrapState || (twitchBootstrapState.done && twitchBootstrapState.error)) {
    log("No stored Twitch user token found. Starting one-time interactive Twitch authorization.");
    twitchBootstrapState = await startInteractiveTwitchAuth();
  }

  if (twitchBootstrapState.done && !twitchBootstrapState.error) {
    return twitchBootstrapState.promise;
  }

  const userCodeHint = twitchBootstrapState.userCode ? ` Use code: ${twitchBootstrapState.userCode}.` : "";
  throw createApiError(
    409,
    `Twitch authorization required. Open this URL, complete authorization, then click Unpublish again: ${twitchBootstrapState.authUrl}.${userCodeHint}`,
    {
      code: "TWITCH_AUTH_REQUIRED",
      authUrl: twitchBootstrapState.authUrl,
      userCode: twitchBootstrapState.userCode,
    }
  );
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

const requestTwitchVodApi = async (vodId, method, tokenRecordInput) => {
  const tokenRecord = tokenRecordInput || (await getValidTwitchToken());
  const request = async (token) =>
    fetch(`https://api.twitch.tv/helix/videos?id=${encodeURIComponent(String(vodId))}`, {
      method,
      headers: {
        "Client-Id": config.twitchClientId,
        Authorization: `Bearer ${token}`,
      },
    });

  let response = await request(tokenRecord.access_token);
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

  return response;
};

const getTwitchVodStatus = async (vodId, tokenRecordInput) => {
  const response = await requestTwitchVodApi(vodId, "GET", tokenRecordInput);
  if (!response.ok) {
    const body = await response.text();
    fail(`Twitch VOD lookup failed (${response.status}): ${body}`);
  }

  const payload = await response.json().catch(() => ({}));
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item) {
    return {
      id: String(vodId),
      exists: false,
      republished: false,
      reason: "Twitch VOD is no longer available and cannot be restored automatically.",
    };
  }

  return {
    id: String(vodId),
    exists: true,
    republished: true,
    reason: "Twitch VOD already exists.",
  };
};

const parseVodRoute = (pathname) => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "vods") return null;
  return {
    vodId: decodeURIComponent(parts[1]),
    action: parts[2],
  };
};

const parseVodPartRoute = (pathname) => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "vods" || parts[2] !== "parts") return null;
  return {
    vodId: decodeURIComponent(parts[1]),
    partRef: decodeURIComponent(parts[3]),
    action: parts[4],
  };
};

const validateConfig = async () => {
  if (!config.adminPassword) fail("ADMIN_PANEL_PASSWORD is required in .env.local");
  await ensureDirectory(path.dirname(config.vodsDataPath));
  await ensureDirectory(path.dirname(config.siteDesignPath));
  await ensureDirectory(config.designAssetsPath);
};

const sortVodsDesc = (vods) =>
  [...vods].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

const isYoutubeVodPart = (entry) => String(entry?.type || "vod") === "vod" && Boolean(entry?.id);

const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  if (rounded < 1) return null;
  return rounded;
};

const listOrderedYoutubeVodParts = (vod) => {
  const source = Array.isArray(vod?.youtube) ? vod.youtube : [];
  const collected = source
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isYoutubeVodPart(entry))
    .map(({ entry, index }, filteredIndex) => ({
      ...entry,
      unpublished: entry?.unpublished === true,
      adminOrder: toPositiveInt(entry?.adminOrder) || null,
      part: toPositiveInt(entry?.part) || filteredIndex + 1,
      __sourceIndex: index,
    }));

  collected.sort((a, b) => {
    const leftOrder = toPositiveInt(a?.adminOrder);
    const rightOrder = toPositiveInt(b?.adminOrder);
    if (leftOrder && rightOrder && leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (leftOrder && !rightOrder) return -1;
    if (!leftOrder && rightOrder) return 1;
    if (a.part !== b.part) return a.part - b.part;
    return a.__sourceIndex - b.__sourceIndex;
  });

  const usedOrders = new Set();
  let nextOrder = 1;
  for (const part of collected) {
    let order = toPositiveInt(part?.adminOrder);
    while (!order || usedOrders.has(order)) {
      if (!usedOrders.has(nextOrder)) {
        order = nextOrder;
        break;
      }
      nextOrder += 1;
    }
    usedOrders.add(order);
    part.adminOrder = order;
    if (order >= nextOrder) nextOrder = order + 1;
  }

  collected.sort((a, b) => {
    if (a.adminOrder !== b.adminOrder) return a.adminOrder - b.adminOrder;
    return a.__sourceIndex - b.__sourceIndex;
  });

  return collected.map(({ __sourceIndex, ...part }) => part);
};

const withPublishedPartNumbers = (orderedParts) => {
  let nextPublishedPartNumber = 1;
  return orderedParts.map((part) => ({
    ...part,
    publishedPartNumber: part.unpublished ? null : nextPublishedPartNumber++,
  }));
};

const renumberVodPartsForSave = (orderedParts) => {
  let nextPublishedPartNumber = 1;
  return orderedParts.map((part) => {
    const { publishedPartNumber, ...rest } = part;
    const isUnpublished = rest?.unpublished === true;
    return {
      ...rest,
      type: "vod",
      adminOrder: toPositiveInt(rest?.adminOrder) || 1,
      part: isUnpublished ? toPositiveInt(rest?.part) || 1 : nextPublishedPartNumber++,
      unpublished: isUnpublished,
    };
  });
};

const withReplacedYoutubeVodParts = (vod, nextVodParts) => {
  const source = Array.isArray(vod?.youtube) ? vod.youtube : [];
  const nonVodEntries = source.filter((entry) => !isYoutubeVodPart(entry));
  return [...nextVodParts, ...nonVodEntries];
};

const handleRequest = async (req, res) => {
  markActivity();
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

  if (method === "GET" && pathname === "/site-design") {
    requireSession(req);
    const design = await loadSiteDesign();
    sendJson(req, res, 200, { design });
    return;
  }

  if (method === "POST" && pathname === "/site-design") {
    requireSession(req);
    const body = await readBodyJson(req);
    const design = body?.design;
    if (!design || typeof design !== "object" || Array.isArray(design)) {
      throw createApiError(400, "Site design payload must be an object.");
    }

    const nextDesign = {
      ...design,
      version: Number(design.version) || 1,
      updatedAt: new Date().toISOString(),
    };

    await saveSiteDesign(nextDesign);
    await stageAndPushSiteDesign("chore: update site design");
    sendJson(req, res, 200, { design: nextDesign });
    return;
  }

  if (method === "POST" && pathname === "/design-assets") {
    requireSession(req);
    const body = await readBodyJson(req);
    const asset = await saveDesignAsset(body);
    await stageAndPushPaths(asset.filePath, "chore: upload design asset", "design asset");
    sendJson(req, res, 200, { url: asset.url });
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

    if (vodRoute.action === "flags") {
      const body = await readBodyJson(req);
      const noticeEnabled = Boolean(body.noticeEnabled);
      const chatReplayAvailable = Boolean(body.chatReplayAvailable);
      const updatedVod = await updateVod(
        vodRoute.vodId,
        (vod) => {
          if (noticeEnabled) vod.vodNotice = config.spotifyNoticeText;
          else delete vod.vodNotice;
          vod.chatReplayAvailable = chatReplayAvailable;
          return vod;
        },
        `chore: update admin flags for vod ${vodRoute.vodId}`
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

      const twitchToken = await getValidTwitchToken();
      const youtubeIds = (Array.isArray(vod.youtube) ? vod.youtube : []).map((entry) => entry?.id).filter(Boolean);
      const youtube = await loadYoutubeClient();
      const youtubeResults = [];
      for (const videoId of youtubeIds) {
        youtubeResults.push(await setYouTubeVideoPrivacy(youtube, videoId, "private"));
      }

      const twitchStatus = await getTwitchVodStatus(vodRoute.vodId, twitchToken);
      const twitchResult = {
        id: String(vodRoute.vodId),
        deleted: false,
        changed: false,
        exists: twitchStatus.exists,
        reason: twitchStatus.exists
          ? "Skipped Twitch deletion to preserve the VOD. Twitch Helix has no official unpublish endpoint."
          : "Twitch VOD not found. No deletion was performed.",
      };

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

    if (vodRoute.action === "republish") {
      const vods = await loadVods();
      const vod = vods.find((entry) => String(entry.id) === String(vodRoute.vodId));
      if (!vod) fail(`VOD ${vodRoute.vodId} not found`);

      const twitchToken = await getValidTwitchToken();
      const youtubeIds = (Array.isArray(vod.youtube) ? vod.youtube : []).map((entry) => entry?.id).filter(Boolean);
      const youtube = await loadYoutubeClient();
      const youtubeResults = [];
      for (const videoId of youtubeIds) {
        youtubeResults.push(await setYouTubeVideoPrivacy(youtube, videoId, "public"));
      }

      const twitchResult = await getTwitchVodStatus(vodRoute.vodId, twitchToken);

      const updatedVod = await updateVod(
        vodRoute.vodId,
        (entry) => ({
          ...entry,
          unpublished: false,
        }),
        `chore: republish vod ${vodRoute.vodId}`
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

  const vodPartRoute = parseVodPartRoute(pathname);
  if (vodPartRoute && method === "POST") {
    requireSession(req);

    if (vodPartRoute.action === "unpublish") {
      const requestedPartNumber = toPositiveInt(vodPartRoute.partRef);
      if (!requestedPartNumber) {
        throw createApiError(400, `Part number must be a positive integer: ${vodPartRoute.partRef}`);
      }

      const vods = await loadVods();
      const vod = vods.find((entry) => String(entry.id) === String(vodPartRoute.vodId));
      if (!vod) {
        throw createApiError(404, `VOD ${vodPartRoute.vodId} not found`);
      }

      const orderedParts = listOrderedYoutubeVodParts(vod);
      const partsWithNumbers = withPublishedPartNumbers(orderedParts);
      const publishedParts = partsWithNumbers.filter((part) => part.unpublished !== true);
      if (publishedParts.length <= 1) {
        throw createApiError(400, `VOD ${vodPartRoute.vodId} has ${publishedParts.length} published part. Cannot unpublish a single part.`);
      }

      const targetPart = publishedParts.find((part) => Number(part?.publishedPartNumber) === requestedPartNumber);
      if (!targetPart) {
        const available = publishedParts.map((part) => part.publishedPartNumber).join(", ");
        throw createApiError(404, `Part ${requestedPartNumber} not found for VOD ${vodPartRoute.vodId}. Available parts: ${available}`);
      }

      const youtube = await loadYoutubeClient();
      const youtubeResult = await setYouTubeVideoPrivacy(youtube, targetPart.id, "private");

      const updatedParts = partsWithNumbers.map((part) =>
        String(part.id) === String(targetPart.id)
          ? {
              ...part,
              unpublished: true,
              part: toPositiveInt(part.part) || requestedPartNumber,
            }
          : part
      );

      const nextParts = renumberVodPartsForSave(updatedParts);
      const remainingPublishedParts = nextParts.filter((part) => part.unpublished !== true);

      const updatedVod = await updateVod(
        vodPartRoute.vodId,
        (entry) => ({
          ...entry,
          youtube: withReplacedYoutubeVodParts(entry, nextParts),
        }),
        `chore: unpublish vod ${vodPartRoute.vodId} part ${requestedPartNumber}`
      );

      sendJson(req, res, 200, {
        vod: updatedVod,
        result: {
          youtube: youtubeResult,
          removedPart: requestedPartNumber,
          removedVideoId: targetPart.id,
          remainingParts: remainingPublishedParts.map((part) => ({
            id: part.id,
            part: part.part,
            adminOrder: part.adminOrder,
          })),
        },
      });
      return;
    }

    if (vodPartRoute.action === "republish") {
      const vods = await loadVods();
      const vod = vods.find((entry) => String(entry.id) === String(vodPartRoute.vodId));
      if (!vod) {
        throw createApiError(404, `VOD ${vodPartRoute.vodId} not found`);
      }

      const orderedParts = listOrderedYoutubeVodParts(vod);
      if (orderedParts.length === 0) {
        throw createApiError(400, `VOD ${vodPartRoute.vodId} has no YouTube VOD parts.`);
      }

      const partRef = String(vodPartRoute.partRef || "").trim();
      if (!partRef) {
        throw createApiError(400, "Part reference is required.");
      }

      let targetPart = orderedParts.find((part) => part.unpublished === true && String(part.id) === partRef);
      if (!targetPart) {
        const numericRef = toPositiveInt(partRef);
        if (numericRef) {
          targetPart = orderedParts.find(
            (part) => part.unpublished === true && (part.adminOrder === numericRef || Number(part.part) === numericRef)
          );
        }
      }
      if (!targetPart) {
        const available = orderedParts
          .filter((part) => part.unpublished === true)
          .map((part) => `${part.id} (backend #${part.adminOrder})`)
          .join(", ");
        throw createApiError(
          404,
          `Unpublished part '${partRef}' not found for VOD ${vodPartRoute.vodId}.${available ? ` Available unpublished parts: ${available}` : ""}`
        );
      }

      const youtube = await loadYoutubeClient();
      const youtubeResult = await setYouTubeVideoPrivacy(youtube, targetPart.id, "public");

      const updatedParts = orderedParts.map((part) =>
        String(part.id) === String(targetPart.id)
          ? {
              ...part,
              unpublished: false,
            }
          : part
      );
      const nextParts = renumberVodPartsForSave(updatedParts);
      const republishedPart = nextParts.find((part) => String(part.id) === String(targetPart.id)) || null;
      const publishedParts = nextParts.filter((part) => part.unpublished !== true);

      const updatedVod = await updateVod(
        vodPartRoute.vodId,
        (entry) => ({
          ...entry,
          youtube: withReplacedYoutubeVodParts(entry, nextParts),
        }),
        `chore: republish vod ${vodPartRoute.vodId} part ${targetPart.id}`
      );

      sendJson(req, res, 200, {
        vod: updatedVod,
        result: {
          youtube: youtubeResult,
          republishedVideoId: targetPart.id,
          republishedPart: republishedPart?.part || null,
          publishedParts: publishedParts.map((part) => ({
            id: part.id,
            part: part.part,
            adminOrder: part.adminOrder,
          })),
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
    markActivity();
    log(`Request failed: ${error.message}`);
    const status = Number(error?.status) || 500;
    const payload = { error: error?.message || "Request failed" };
    if (error?.code) payload.code = error.code;
    if (error?.authUrl) payload.authUrl = error.authUrl;
    if (error?.userCode) payload.userCode = error.userCode;
    sendJson(req, res, status, payload);
  });
});

server.listen(config.port, config.host, () => {
  markActivity();
  log(`Soft admin API listening on http://${config.host}:${config.port}`);
});

setInterval(pruneSessions, 60 * 1000).unref();

if (Number.isFinite(config.adminIdleTimeoutMinutes) && config.adminIdleTimeoutMinutes > 0) {
  const idleTimeoutMs = config.adminIdleTimeoutMinutes * 60 * 1000;
  const checkEveryMs = Math.min(60 * 1000, Math.max(15 * 1000, Math.floor(idleTimeoutMs / 4)));

  setInterval(() => {
    if (shuttingDownForIdle) return;
    if (Date.now() - lastActivityAt < idleTimeoutMs) return;

    shuttingDownForIdle = true;
    log(`No admin API activity for ${config.adminIdleTimeoutMinutes} minutes. Shutting down.`);
    server.close(() => {
      process.exit(0);
    });
  }, checkEveryMs).unref();
}
