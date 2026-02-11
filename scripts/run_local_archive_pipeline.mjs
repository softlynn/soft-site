import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import dotenv from "dotenv";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const METADATA_TEMPLATE_VERSION = 1;

const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");

const config = {
  recordingsDir: process.env.LOCAL_RECORDINGS_DIR || "Z:/Stream Archives",
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "softu1",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  youtubeClientSecretPath: process.env.YOUTUBE_CLIENT_SECRET_PATH || "C:/Users/Alex2/Documents/youtube_client_secret.json",
  youtubeTokenPath: process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json"),
  youtubePrivacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "private",
  youtubeCategoryId: process.env.YOUTUBE_CATEGORY_ID || "20",
  youtubeCategoryRegionCode: process.env.YOUTUBE_CATEGORY_REGION_CODE || "US",
  archiveSiteUrl: cleanUrl(process.env.ARCHIVE_SITE_URL || "https://softlynn.github.io/soft-site"),
  vodsDataPath: process.env.ARCHIVE_VODS_PATH || path.join(repoRoot, "public", "data", "vods.json"),
  commentsDir: process.env.ARCHIVE_COMMENTS_DIR || path.join(repoRoot, "public", "data", "comments"),
  emotesDir: process.env.ARCHIVE_EMOTES_DIR || path.join(repoRoot, "public", "data", "emotes"),
  statePath: process.env.PIPELINE_STATE_PATH || path.join(repoRoot, "scripts", ".state", "pipeline-state.json"),
  tmpDir: process.env.PIPELINE_TMP_DIR || path.join(repoRoot, "scripts", ".tmp"),
  minRecordingAgeMinutes: Number(process.env.MIN_RECORDING_AGE_MINUTES || "10"),
  maxRecordingsPerRun: Number(process.env.MAX_RECORDINGS_PER_RUN || "1"),
  autoGitPush: (process.env.AUTO_GIT_PUSH || "true").toLowerCase() === "true",
  dryRun: (process.env.LOCAL_PIPELINE_DRY_RUN || "false").toLowerCase() === "true",
  twitchDownloaderPath: process.env.TWITCHDOWNLOADER_PATH || path.join(repoRoot, "scripts", "tools", "TwitchDownloaderCLI.exe"),
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".flv", ".m4v"]);

const log = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};

const fail = (message) => {
  throw new Error(message);
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
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents);
};

const writeJsonFile = async (filePath, value) => {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const listRecordingFiles = async (dirPath) => {
  const files = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRecordingFiles(fullPath)));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    const stat = await fs.stat(fullPath);
    files.push({
      path: path.resolve(fullPath),
      name: entry.name,
      size: stat.size,
      modifiedAtMs: stat.mtimeMs,
    });
  }

  return files;
};

const parseTwitchDurationToSeconds = (durationText) => {
  const match = String(durationText || "").match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match) return 0;

  const hours = Number(match[1] || "0");
  const minutes = Number(match[2] || "0");
  const seconds = Number(match[3] || "0");
  return hours * 3600 + minutes * 60 + seconds;
};

const formatDuration = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
};

const parseYouTubeDurationToSeconds = (durationText) => {
  const match = String(durationText || "").match(/^P(?:([\d.]+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return 0;

  const days = Number(match[1] || "0");
  const hours = Number(match[2] || "0");
  const minutes = Number(match[3] || "0");
  const seconds = Number(match[4] || "0");
  return Math.round(days * 86400 + hours * 3600 + minutes * 60 + seconds);
};

const sanitizeTitle = (title) =>
  String(title || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const formatDateLabel = (input) => {
  const date = new Date(input || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown-date";

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatDateDescription = (input) => {
  const date = new Date(input || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

const truncateYouTubeTitle = (title, maxLength = 100) => {
  const normalized = String(title || "").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const buildYouTubeTitle = ({ streamTitle, streamDate, partNumber, totalParts }) => {
  const safeTitle = sanitizeTitle(streamTitle || "Stream");
  const dateLabel = formatDateLabel(streamDate);

  if (totalParts > 1) {
    const suffix = ` - ${dateLabel} - Part ${partNumber}`;
    const maxBaseLength = Math.max(1, 100 - suffix.length);
    const base = safeTitle.length > maxBaseLength ? `${safeTitle.slice(0, maxBaseLength - 3).trimEnd()}...` : safeTitle;
    return truncateYouTubeTitle(`${base}${suffix}`);
  }

  return truncateYouTubeTitle(`${safeTitle} - ${dateLabel}`);
};

const buildArchiveVodUrl = (vodId) => `${config.archiveSiteUrl}/#/youtube/${vodId}`;

const buildYouTubeDescription = ({ twitchVodId, streamTitle, streamDate, partNumber, totalParts, youtubeParts = [] }) => {
  const lines = [
    `Chat Replay: ${buildArchiveVodUrl(twitchVodId)}`,
    `Original VOD: https://www.twitch.tv/videos/${twitchVodId}`,
    `Stream Title: ${sanitizeTitle(streamTitle) || `Twitch VOD ${twitchVodId}`}`,
    `Stream Date: ${formatDateDescription(streamDate)}`,
  ];

  if (totalParts > 1) {
    lines.push(`Part ${partNumber} of ${totalParts}`);
    if (youtubeParts.length > 1) {
      lines.push("");
      lines.push("Parts:");
      for (const part of youtubeParts.sort((a, b) => (a.part || 0) - (b.part || 0))) {
        lines.push(`PART ${part.part}: https://www.youtube.com/watch?v=${part.id}`);
      }
    }
  }

  return lines.join("\n").trim();
};

const normalizeThumbnailUrl = (thumbnailUrl) =>
  String(thumbnailUrl || "")
    .replace(/%\{width\}/g, "640")
    .replace(/%\{height\}/g, "360");

const fetchTwitchAppAccessToken = async () => {
  const tokenUrl = new URL("https://id.twitch.tv/oauth2/token");
  tokenUrl.searchParams.set("client_id", config.twitchClientId);
  tokenUrl.searchParams.set("client_secret", config.twitchClientSecret);
  tokenUrl.searchParams.set("grant_type", "client_credentials");

  const response = await fetch(tokenUrl.toString(), { method: "POST" });
  if (!response.ok) {
    fail(`Unable to obtain Twitch token (${response.status})`);
  }

  const data = await response.json();
  if (!data.access_token) fail("Twitch token response missing access_token");
  return data.access_token;
};

const fetchJsonSafe = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) return null;
  return response.json();
};

const fetchTwitchUser = async (accessToken) => {
  const url = new URL("https://api.twitch.tv/helix/users");
  url.searchParams.set("login", config.twitchChannelLogin);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) fail(`Unable to fetch Twitch user (${response.status})`);
  const data = await response.json();
  if (!data.data || data.data.length === 0) fail(`Twitch user not found for login "${config.twitchChannelLogin}"`);
  return data.data[0];
};

const fetchTwitchArchives = async (accessToken, userId) => {
  const url = new URL("https://api.twitch.tv/helix/videos");
  url.searchParams.set("user_id", userId);
  url.searchParams.set("type", "archive");
  url.searchParams.set("first", "20");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) fail(`Unable to fetch Twitch archives (${response.status})`);
  const data = await response.json();
  return data.data || [];
};

const fetchFFZEmotes = async (twitchUserId) => {
  const data = await fetchJsonSafe(`https://api.frankerfacez.com/v1/room/id/${twitchUserId}`);
  if (!data?.room?.set || !data?.sets?.[data.room.set]?.emoticons) return [];

  return data.sets[data.room.set].emoticons.map((emote) => ({
    id: String(emote.id),
    code: emote.name,
    name: emote.name,
  }));
};

const fetchBTTVEmotes = async (twitchUserId) => {
  const [globalEmotes, userData] = await Promise.all([
    fetchJsonSafe("https://api.betterttv.net/3/cached/emotes/global"),
    fetchJsonSafe(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`),
  ]);

  const combined = [];
  if (Array.isArray(globalEmotes)) combined.push(...globalEmotes);
  if (Array.isArray(userData?.channelEmotes)) combined.push(...userData.channelEmotes);
  if (Array.isArray(userData?.sharedEmotes)) combined.push(...userData.sharedEmotes);

  const deduped = new Map();
  for (const emote of combined) {
    const code = emote?.code;
    const id = emote?.id;
    if (!code || !id) continue;
    deduped.set(`${code}:${id}`, { id: String(id), code, name: code });
  }

  return [...deduped.values()];
};

const fetch7TVEmotes = async (twitchUserId) => {
  const data = await fetchJsonSafe(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
  const emotes = Array.isArray(data?.emote_set?.emotes) ? data.emote_set.emotes : [];

  return emotes
    .map((emote) => ({
      id: String(emote.id || ""),
      code: emote.name || "",
      name: emote.name || "",
    }))
    .filter((emote) => emote.id && emote.code);
};

const fetchThirdPartyEmoteSets = async (twitchUserId) => {
  const [ffz, bttv, sevenTv] = await Promise.all([fetchFFZEmotes(twitchUserId), fetchBTTVEmotes(twitchUserId), fetch7TVEmotes(twitchUserId)]);
  return {
    ffz_emotes: ffz,
    bttv_emotes: bttv,
    "7tv_emotes": sevenTv,
  };
};

const ensureTwitchDownloader = async () => {
  if (await fileExists(config.twitchDownloaderPath)) return config.twitchDownloaderPath;

  const installerPath = path.join(repoRoot, "scripts", "ensure_twitchdownloader.ps1");
  log("TwitchDownloaderCLI not found. Installing...");

  const install = spawnSync(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", installerPath, "-OutputPath", config.twitchDownloaderPath],
    { stdio: "inherit" }
  );

  if (install.status !== 0 || !(await fileExists(config.twitchDownloaderPath))) {
    fail("Failed to install TwitchDownloaderCLI");
  }

  return config.twitchDownloaderPath;
};

const downloadTwitchChatJson = async (twitchVodId, outputPath) => {
  const exePath = await ensureTwitchDownloader();
  await ensureDirectory(path.dirname(outputPath));

  const command = spawnSync(
    exePath,
    ["chatdownload", "--id", String(twitchVodId), "--output", outputPath, "--embed-images", "false", "--threads", "8", "--collision", "overwrite"],
    { stdio: "inherit" }
  );

  if (command.status !== 0 || !(await fileExists(outputPath))) {
    fail(`Failed to download chat for Twitch VOD ${twitchVodId}`);
  }
};

const extractEmbeddedThirdPartyEmotes = (rawChat) => {
  const embedded = Array.isArray(rawChat?.embeddedData?.thirdParty) ? rawChat.embeddedData.thirdParty : [];
  const deduped = new Map();

  for (const emote of embedded) {
    const code = String(emote?.name || "").trim();
    const id = String(emote?.id || "").trim();
    if (!code || !id) continue;

    deduped.set(code.toLowerCase(), {
      id,
      code,
      name: code,
      data: typeof emote.data === "string" ? emote.data : null,
      width: Number(emote.width || 0) || null,
      height: Number(emote.height || 0) || null,
      isZeroWidth: Boolean(emote.isZeroWidth),
    });
  }

  return [...deduped.values()];
};

const normalizeChatComments = (rawChat) => {
  const comments = Array.isArray(rawChat.comments) ? rawChat.comments : [];

  const normalized = comments.map((comment, index) => {
    const fragments = Array.isArray(comment.message?.fragments)
      ? comment.message.fragments.map((fragment) => ({
          text: fragment.text ?? "",
          emote: fragment.emote ?? (fragment.emoticon?.emoticon_id ? { emoteID: String(fragment.emoticon.emoticon_id) } : undefined),
          emoticon: fragment.emoticon ?? null,
        }))
      : [{ text: comment.message?.body ?? "" }];

    return {
      id: comment._id || `comment-${index}`,
      created_at: comment.created_at || null,
      content_offset_seconds: Number(comment.content_offset_seconds || 0),
      display_name: comment.commenter?.display_name || comment.commenter?.name || "unknown",
      user_badges: comment.message?.user_badges || [],
      user_color: comment.message?.user_color || null,
      message: fragments,
    };
  });

  normalized.sort((a, b) => a.content_offset_seconds - b.content_offset_seconds);
  return normalized;
};

const loadYoutubeClient = async () => {
  if (!(await fileExists(config.youtubeClientSecretPath))) {
    fail(`Missing YouTube OAuth client file at ${config.youtubeClientSecretPath}`);
  }

  if (!(await fileExists(config.youtubeTokenPath))) {
    fail(`Missing YouTube OAuth token at ${config.youtubeTokenPath}. Run: npm run youtube:auth`);
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

const ensureYouTubeCategoryExists = async (youtube) => {
  const response = await youtube.videoCategories.list({
    part: ["snippet"],
    id: [config.youtubeCategoryId],
  });

  if (!response.data.items || response.data.items.length === 0) {
    fail(`YouTube category ${config.youtubeCategoryId} is invalid`);
  }
};

const uploadRecordingToYouTube = async ({ youtube, recordingFile, title, description }) => {
  log(`Uploading to YouTube: ${recordingFile.path}`);
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: true,
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: config.youtubeCategoryId,
      },
      status: {
        privacyStatus: config.youtubePrivacyStatus,
      },
    },
    media: {
      body: fsSync.createReadStream(recordingFile.path),
    },
  });

  const videoId = response.data.id;
  if (!videoId) fail("YouTube upload succeeded without a returned video ID");
  return String(videoId);
};

const fetchYouTubeVideoDetails = async (youtube, videoId) => {
  const response = await youtube.videos.list({
    part: ["contentDetails", "snippet"],
    id: [videoId],
  });

  const item = response.data.items?.[0];
  if (!item) return { durationSeconds: 0, thumbnailUrl: null };

  const durationSeconds = parseYouTubeDurationToSeconds(item.contentDetails?.duration);
  const thumbnailUrl = item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null;
  return { durationSeconds, thumbnailUrl };
};

const updateYouTubeVideoMetadata = async (youtube, videoId, { title, description }) => {
  const response = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });
  const item = response.data.items?.[0];
  if (!item?.snippet) return;

  const snippet = item.snippet;
  await youtube.videos.update({
    part: ["snippet"],
    requestBody: {
      id: videoId,
      snippet: {
        ...snippet,
        title,
        description,
        categoryId: config.youtubeCategoryId,
      },
    },
  });
};

const syncYouTubeMetadataForVod = async (youtube, vodEntry) => {
  const twitchVodId = String(vodEntry.id);
  const streamTitle = vodEntry.title || `Twitch VOD ${twitchVodId}`;
  const streamDate = vodEntry.createdAt;
  const vodParts = (Array.isArray(vodEntry.youtube) ? vodEntry.youtube : [])
    .filter((part) => part.type === "vod" && part.id)
    .sort((a, b) => (a.part || 0) - (b.part || 0));

  if (vodParts.length === 0) return;

  const totalParts = vodParts.length;
  for (const part of vodParts) {
    const title = buildYouTubeTitle({
      streamTitle,
      streamDate,
      partNumber: part.part || 1,
      totalParts,
    });
    const description = buildYouTubeDescription({
      twitchVodId,
      streamTitle,
      streamDate,
      partNumber: part.part || 1,
      totalParts,
      youtubeParts: vodParts,
    });

    await updateYouTubeVideoMetadata(youtube, part.id, { title, description });
  }
};

const upsertVod = (vods, entry) => {
  const index = vods.findIndex((vod) => String(vod.id) === String(entry.id));
  if (index >= 0) {
    vods[index] = entry;
  } else {
    vods.push(entry);
  }
  vods.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
};

const stageAndPushArchiveData = (filePaths, commitMessage) => {
  const relPaths = filePaths.map((filePath) => path.relative(repoRoot, filePath));
  const gitAdd = spawnSync("git", ["add", ...relPaths], { cwd: repoRoot, stdio: "inherit" });
  if (gitAdd.status !== 0) fail("git add failed");

  const checkDiff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: repoRoot });
  if (checkDiff.status === 0) {
    log("No archive data changes to commit.");
    return;
  }

  const commit = spawnSync("git", ["commit", "-m", commitMessage], { cwd: repoRoot, stdio: "inherit" });
  if (commit.status !== 0) fail("git commit failed");

  const push = spawnSync("git", ["push", "origin", "main"], { cwd: repoRoot, stdio: "inherit" });
  if (push.status !== 0) fail("git push failed");
};

const selectMatchingVod = (recordingFile, twitchVods) => {
  if (twitchVods.length === 0) return null;
  const fileTime = recordingFile.modifiedAtMs;
  const candidates = twitchVods
    .map((vod) => ({
      vod,
      deltaMs: Math.abs(new Date(vod.created_at).getTime() - fileTime),
    }))
    .sort((a, b) => a.deltaMs - b.deltaMs);

  const best = candidates[0];
  const maxDeltaMs = 48 * 60 * 60 * 1000;
  if (!best || best.deltaMs > maxDeltaMs) return null;
  return best.vod;
};

const buildBaseVodEntry = (twitchVod, chatJson) => {
  const durationSeconds = parseTwitchDurationToSeconds(twitchVod.duration);
  const thumbnail = normalizeThumbnailUrl(twitchVod.thumbnail_url);
  const chapters = (chatJson?.video?.chapters || []).map((chapter, index) => ({
    gameId: chapter.gameId || `${index}`,
    start: Math.floor((chapter.startMilliseconds || 0) / 1000),
    end: Math.floor((chapter.lengthMilliseconds || 0) / 1000),
    name: chapter.gameDisplayName || chapter.description || `Chapter ${index + 1}`,
    image: chapter.gameBoxArtUrl || thumbnail,
  }));

  return {
    id: String(twitchVod.id),
    title: twitchVod.title || `Twitch VOD ${twitchVod.id}`,
    duration: formatDuration(durationSeconds),
    thumbnail_url: thumbnail,
    youtube: [],
    stream_id: twitchVod.stream_id || null,
    drive: [],
    platform: "twitch",
    chapters,
    games: [],
    createdAt: twitchVod.created_at,
    updatedAt: new Date().toISOString(),
  };
};

const ensureVodEntry = (existingVods, twitchVod, chatJson) => {
  const index = existingVods.findIndex((vod) => String(vod.id) === String(twitchVod.id));
  const base = buildBaseVodEntry(twitchVod, chatJson);

  if (index < 0) return base;

  const existing = existingVods[index];
  return {
    ...base,
    ...existing,
    id: base.id,
    title: base.title,
    duration: base.duration,
    thumbnail_url: base.thumbnail_url,
    stream_id: base.stream_id,
    platform: "twitch",
    chapters: base.chapters,
    youtube: Array.isArray(existing.youtube) ? existing.youtube : [],
    drive: Array.isArray(existing.drive) ? existing.drive : [],
    games: Array.isArray(existing.games) ? existing.games : [],
    updatedAt: new Date().toISOString(),
  };
};

const addOrUpdateYouTubePart = (vodEntry, partData) => {
  const youtubeParts = Array.isArray(vodEntry.youtube) ? [...vodEntry.youtube] : [];
  const indexByPart = youtubeParts.findIndex((part) => part.type === "vod" && Number(part.part) === Number(partData.part));
  const nextPart = {
    id: partData.id,
    type: "vod",
    duration: Number(partData.duration || 0),
    part: Number(partData.part),
    thumbnail_url: partData.thumbnail_url || vodEntry.thumbnail_url,
  };

  if (indexByPart >= 0) youtubeParts[indexByPart] = nextPart;
  else youtubeParts.push(nextPart);

  youtubeParts.sort((a, b) => (a.part || 0) - (b.part || 0));
  vodEntry.youtube = youtubeParts;
  vodEntry.updatedAt = new Date().toISOString();
};

const requiredConfig = [
  ["TWITCH_CLIENT_ID", config.twitchClientId],
  ["TWITCH_CLIENT_SECRET", config.twitchClientSecret],
  ["TWITCH_CHANNEL_LOGIN", config.twitchChannelLogin],
  ["LOCAL_RECORDINGS_DIR", config.recordingsDir],
  ["YOUTUBE_CLIENT_SECRET_PATH", config.youtubeClientSecretPath],
];

const validateConfiguration = async () => {
  const missing = requiredConfig.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) fail(`Missing required configuration: ${missing.join(", ")}`);

  if (!(await fileExists(config.recordingsDir))) fail(`Recording directory does not exist: ${config.recordingsDir}`);
};

const run = async () => {
  await validateConfiguration();
  await ensureDirectory(path.dirname(config.vodsDataPath));
  await ensureDirectory(config.commentsDir);
  await ensureDirectory(config.emotesDir);
  await ensureDirectory(path.dirname(config.statePath));
  await ensureDirectory(config.tmpDir);

  const state = await readJsonFile(config.statePath, {
    processedFiles: {},
    processedVodIds: {},
  });

  const existingVods = await readJsonFile(config.vodsDataPath, []);
  const existingVodIds = new Set(existingVods.map((vod) => String(vod.id)));

  const now = Date.now();
  const minAgeMs = config.minRecordingAgeMinutes * 60 * 1000;
  const recordings = (await listRecordingFiles(config.recordingsDir))
    .filter((file) => now - file.modifiedAtMs >= minAgeMs)
    .filter((file) => !(state.processedFiles?.[file.path]?.status === "completed"))
    .sort((a, b) => a.modifiedAtMs - b.modifiedAtMs);

  const missingEmoteVodIds = [];
  for (const vod of existingVods) {
    const emotePath = path.join(config.emotesDir, `${vod.id}.json`);
    if (!(await fileExists(emotePath))) missingEmoteVodIds.push(String(vod.id));
  }

  const vodsNeedingMetadataSync = existingVods.filter((vod) => {
    const youtubeParts = Array.isArray(vod.youtube) ? vod.youtube.filter((part) => part.id) : [];
    if (youtubeParts.length === 0) return false;
    const metadataVersion = Number(state.processedVodIds?.[String(vod.id)]?.metadataVersion || 0);
    return metadataVersion < METADATA_TEMPLATE_VERSION;
  });

  if (recordings.length === 0 && missingEmoteVodIds.length === 0 && vodsNeedingMetadataSync.length === 0) {
    log("No completed recordings ready for processing.");
    return;
  }

  const twitchAccessToken = await fetchTwitchAppAccessToken();
  const twitchUser = await fetchTwitchUser(twitchAccessToken);
  const twitchVods = recordings.length > 0 ? await fetchTwitchArchives(twitchAccessToken, twitchUser.id) : [];
  const channelEmoteSets = await fetchThirdPartyEmoteSets(twitchUser.id);

  if (recordings.length > 0 && twitchVods.length === 0) {
    log("No Twitch archives found yet.");
  }

  const targets = recordings.slice(0, Math.max(1, config.maxRecordingsPerRun));
  const plannedUploads = [];
  for (const recording of targets) {
    const matchedVod = selectMatchingVod(recording, twitchVods);
    if (!matchedVod) {
      log(`No Twitch VOD match found for recording: ${recording.name}`);
      continue;
    }
    plannedUploads.push({ recording, twitchVod: matchedVod });
    log(`Matched recording "${recording.name}" -> Twitch VOD ${matchedVod.id}`);
  }

  const uploadsByVod = new Map();
  for (const upload of plannedUploads) {
    const key = String(upload.twitchVod.id);
    if (!uploadsByVod.has(key)) uploadsByVod.set(key, []);
    uploadsByVod.get(key).push(upload);
  }
  for (const group of uploadsByVod.values()) {
    group.sort((a, b) => a.recording.modifiedAtMs - b.recording.modifiedAtMs);
  }

  const stagedPaths = [];
  let vodsUpdated = false;

  if (!config.dryRun && missingEmoteVodIds.length > 0) {
    for (const vodId of missingEmoteVodIds) {
      const emotesPath = path.join(config.emotesDir, `${vodId}.json`);
      await writeJsonFile(emotesPath, {
        source: "local-archive-pipeline",
        twitchVodId: vodId,
        generatedAt: new Date().toISOString(),
        ...channelEmoteSets,
        embedded_emotes: [],
      });
      stagedPaths.push(emotesPath);
      const previous = state.processedVodIds?.[vodId] || {};
      state.processedVodIds[vodId] = {
        ...previous,
        emotesBackfilledAt: new Date().toISOString(),
      };
      log(`Backfilled emotes for VOD ${vodId}`);
    }
  }

  const needsYouTubeClient = !config.dryRun && (uploadsByVod.size > 0 || vodsNeedingMetadataSync.length > 0);
  const youtube = needsYouTubeClient ? await loadYoutubeClient() : null;
  if (youtube) {
    await ensureYouTubeCategoryExists(youtube);
  }

  for (const [vodId, uploads] of uploadsByVod.entries()) {
    const twitchVod = uploads[0].twitchVod;
    const commentsPath = path.join(config.commentsDir, `${vodId}.json`);
    const emotesPath = path.join(config.emotesDir, `${vodId}.json`);
    const rawChatPath = path.join(config.tmpDir, `${vodId}-chat-raw.json`);

    await downloadTwitchChatJson(vodId, rawChatPath);

    const rawChat = await readJsonFile(rawChatPath, {});
    const comments = normalizeChatComments(rawChat);
    const embeddedEmotes = extractEmbeddedThirdPartyEmotes(rawChat);
    const emotePayload = {
      source: "local-archive-pipeline",
      twitchVodId: vodId,
      generatedAt: new Date().toISOString(),
      ...channelEmoteSets,
      embedded_emotes: embeddedEmotes,
    };

    if (config.dryRun) {
      log(`[DRY RUN] Chat export succeeded for VOD ${vodId} (${comments.length} comments, ${embeddedEmotes.length} embedded emotes).`);
      continue;
    }

    await writeJsonFile(commentsPath, {
      source: "twitchdownloader",
      twitchVodId: vodId,
      generatedAt: new Date().toISOString(),
      comments,
    });
    await writeJsonFile(emotesPath, emotePayload);
    stagedPaths.push(commentsPath);
    stagedPaths.push(emotesPath);

    const vodEntry = ensureVodEntry(existingVods, twitchVod, rawChat);
    const existingParts = (Array.isArray(vodEntry.youtube) ? vodEntry.youtube : [])
      .filter((part) => part.type === "vod")
      .sort((a, b) => (a.part || 0) - (b.part || 0));
    const nextPartNumber = (existingParts[existingParts.length - 1]?.part || 0) + 1;
    const totalPartsAfterUpload = existingParts.length + uploads.length;

    for (let index = 0; index < uploads.length; index++) {
      const { recording } = uploads[index];
      const partNumber = nextPartNumber + index;

      const title = buildYouTubeTitle({
        streamTitle: twitchVod.title || path.parse(recording.name).name,
        streamDate: twitchVod.created_at,
        partNumber,
        totalParts: totalPartsAfterUpload,
      });
      const description = buildYouTubeDescription({
        twitchVodId: vodId,
        streamTitle: twitchVod.title,
        streamDate: twitchVod.created_at,
        partNumber,
        totalParts: totalPartsAfterUpload,
        youtubeParts: [],
      });

      const youtubeVideoId = await uploadRecordingToYouTube({
        youtube,
        recordingFile: recording,
        title,
        description,
      });
      const details = await fetchYouTubeVideoDetails(youtube, youtubeVideoId);

      addOrUpdateYouTubePart(vodEntry, {
        id: youtubeVideoId,
        part: partNumber,
        duration: details.durationSeconds || 0,
        thumbnail_url: details.thumbnailUrl || vodEntry.thumbnail_url,
      });

      state.processedFiles[recording.path] = {
        status: "completed",
        twitchVodId: vodId,
        youtubeVideoId,
        part: partNumber,
        processedAt: new Date().toISOString(),
      };

      log(`Completed pipeline for Twitch VOD ${vodId} -> YouTube ${youtubeVideoId} (Part ${partNumber})`);
    }

    await syncYouTubeMetadataForVod(youtube, vodEntry);
    upsertVod(existingVods, vodEntry);
    existingVodIds.add(vodId);
    vodsUpdated = true;

    const existingState = state.processedVodIds?.[vodId] || {};
    state.processedVodIds[vodId] = {
      ...existingState,
      metadataVersion: METADATA_TEMPLATE_VERSION,
      metadataSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (!config.dryRun && youtube) {
    for (const vod of vodsNeedingMetadataSync) {
      if (!vod?.id || !Array.isArray(vod.youtube) || vod.youtube.length === 0) continue;
      await syncYouTubeMetadataForVod(youtube, vod);

      const vodId = String(vod.id);
      const existingState = state.processedVodIds?.[vodId] || {};
      state.processedVodIds[vodId] = {
        ...existingState,
        metadataVersion: METADATA_TEMPLATE_VERSION,
        metadataSyncedAt: new Date().toISOString(),
      };
      log(`Synced YouTube metadata template for VOD ${vodId}`);
    }
  }

  if (!config.dryRun) {
    if (vodsUpdated) {
      await writeJsonFile(config.vodsDataPath, existingVods);
      stagedPaths.push(config.vodsDataPath);
    }
    await writeJsonFile(config.statePath, state);
  }

  if (!config.dryRun && config.autoGitPush && stagedPaths.length > 0) {
    stageAndPushArchiveData(stagedPaths, "chore: update archive vod data");
  }
};

run()
  .then(() => {
    log("Local archive pipeline finished.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
