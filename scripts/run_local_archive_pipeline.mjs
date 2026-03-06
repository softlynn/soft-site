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

const METADATA_TEMPLATE_VERSION = 5;
const DEFAULT_ARCHIVE_SITE_URL = "https://softu.one";

const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");

const parseGithubRepo = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^github\.com[/:]/i, "https://github.com/");
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized.replace(/^\/+/, "")}`;
    }
  }

  try {
    const parsed = new URL(normalized);
    if (!/github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return null;
    return {
      owner: parts[0],
      repo: parts[1],
    };
  } catch {
    return null;
  }
};

const inferArchiveSiteUrl = () => {
  const configured = cleanUrl(process.env.ARCHIVE_SITE_URL || "");
  if (configured) return configured;
  return DEFAULT_ARCHIVE_SITE_URL;
};

const inferUploadStatusApiBase = () => {
  const configured = cleanUrl(process.env.UPLOAD_STATUS_API_BASE || process.env.REACT_APP_UPLOADS_API_BASE || "");
  if (configured) return configured;

  const reactionsBase = cleanUrl(process.env.REACT_APP_REACTIONS_API_BASE || "");
  if (reactionsBase) {
    return reactionsBase.replace(/\/v1\/reactions$/i, "/v1/uploads");
  }

  return "";
};

const inferFfprobePath = () => {
  const explicit = String(process.env.FFPROBE_PATH || "").trim();
  if (explicit) return explicit;

  const ffmpegPath = String(process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";
  const parsed = path.parse(ffmpegPath);
  const lowerBase = parsed.base.toLowerCase();
  if (lowerBase.startsWith("ffmpeg")) {
    const nextName = parsed.name.replace(/ffmpeg/i, "ffprobe");
    return path.join(parsed.dir, `${nextName}${parsed.ext}`);
  }
  return "ffprobe";
};

const config = {
  recordingsDir: process.env.LOCAL_RECORDINGS_DIR || path.join(repoRoot, "recordings"),
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  youtubeClientSecretPath: process.env.YOUTUBE_CLIENT_SECRET_PATH || path.join(repoRoot, "secrets", "youtube_client_secret.json"),
  youtubeTokenPath: process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json"),
  youtubePrivacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "private",
  youtubeCategoryId: process.env.YOUTUBE_CATEGORY_ID || "20",
  youtubeCategoryRegionCode: process.env.YOUTUBE_CATEGORY_REGION_CODE || "US",
  archiveSiteUrl: inferArchiveSiteUrl(),
  vodsDataPath: process.env.ARCHIVE_VODS_PATH || path.join(repoRoot, "public", "data", "vods.json"),
  commentsDir: process.env.ARCHIVE_COMMENTS_DIR || path.join(repoRoot, "public", "data", "comments"),
  emotesDir: process.env.ARCHIVE_EMOTES_DIR || path.join(repoRoot, "public", "data", "emotes"),
  statePath: process.env.PIPELINE_STATE_PATH || path.join(repoRoot, "scripts", ".state", "pipeline-state.json"),
  runLockPath: process.env.PIPELINE_RUN_LOCK_PATH || path.join(repoRoot, "scripts", ".state", "pipeline-run.lock.json"),
  tmpDir: process.env.PIPELINE_TMP_DIR || path.join(repoRoot, "scripts", ".tmp"),
  minRecordingAgeMinutes: Number(process.env.MIN_RECORDING_AGE_MINUTES || "10"),
  maxRecordingsPerRun: Number(process.env.MAX_RECORDINGS_PER_RUN || "1"),
  autoGitPush: (process.env.AUTO_GIT_PUSH || "true").toLowerCase() === "true",
  dryRun: (process.env.LOCAL_PIPELINE_DRY_RUN || "false").toLowerCase() === "true",
  twitchDownloaderPath: process.env.TWITCHDOWNLOADER_PATH || path.join(repoRoot, "scripts", "tools", "TwitchDownloaderCLI.exe"),
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: inferFfprobePath(),
  uploadStatusApiBase: inferUploadStatusApiBase(),
  uploadStatusApiSecret: process.env.UPLOAD_STATUS_API_SECRET || "",
  minArchiveVodDurationSeconds: Number(process.env.MIN_ARCHIVE_VOD_DURATION_SECONDS || "300"),
  autoMergeVodGapSeconds: Number(process.env.AUTO_MERGE_VOD_GAP_SECONDS || "3600"),
  obsDockUploadStatusPath:
    process.env.OBS_VOD_BYPASS_UPLOAD_STATUS_PATH ||
    (process.env.APPDATA
      ? path.join(process.env.APPDATA, "obs-studio", "plugin_config", "obs-vod-track-toggle", "upload_status.json")
      : ""),
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".flv", ".m4v"]);
const ACTIVE_PROCESSED_FILE_STATUSES = new Set(["processing"]);
const TERMINAL_PROCESSED_FILE_STATUSES = new Set([
  "completed",
  "ignored_short",
  "ignored_short_uploaded",
  "ignored_unknown_duration",
]);
const PIPELINE_RUN_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PROCESSING_RECORD_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

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

const parseTimestampMs = (value) => {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const isCurrentProcessRunning = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquirePipelineRunLock = async (lockPath) => {
  await ensureDirectory(path.dirname(lockPath));

  const tryWriteLock = async () => {
    const nowMs = Date.now();
    const payload = {
      pid: process.pid,
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      argv: process.argv.slice(1),
    };
    await fs.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await tryWriteLock();
      return async () => {
        try {
          await fs.rm(lockPath, { force: true });
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const existing = await readJsonFile(lockPath, null);
      const createdAtMs = Number(existing?.createdAtMs) || parseTimestampMs(existing?.createdAt) || 0;
      const ageMs = Math.max(0, Date.now() - createdAtMs);
      const ownerAlive = isCurrentProcessRunning(existing?.pid);
      const staleLock = !ownerAlive || ageMs > PIPELINE_RUN_LOCK_MAX_AGE_MS;

      if (!staleLock) {
        return null;
      }

      try {
        await fs.rm(lockPath, { force: true });
      } catch {}
    }
  }

  return null;
};

const writeObsDockUploadStatus = async (status = {}) => {
  const outputPath = String(config.obsDockUploadStatusPath || "").trim();
  if (!outputPath) return;

  const payload = {
    visible: false,
    state: "idle",
    message: "",
    percent: null,
    hide_after_ms: 0,
    updated_at_ms: Date.now(),
    ...status,
  };

  try {
    await writeJsonFile(outputPath, payload);
  } catch (error) {
    log(`Failed to write OBS dock upload status: ${error.message}`);
  }
};

const postRealtimeUploadStatus = async (status = {}) => {
  const apiBase = cleanUrl(config.uploadStatusApiBase || "");
  const writeSecret = String(config.uploadStatusApiSecret || "").trim();
  if (!apiBase || !writeSecret) return;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 5000);
  if (typeof timeoutHandle?.unref === "function") timeoutHandle.unref();

  try {
    const response = await fetch(`${apiBase}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Status-Secret": writeSecret,
      },
      body: JSON.stringify(status),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Upload status API ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    }
  } catch (error) {
    const state = String(status?.state || "").toLowerCase();
    if (state !== "uploading" || Number(status?.percent || 0) % 10 === 0) {
      log(`Failed to post realtime upload status${state ? ` (${state})` : ""}: ${error.message}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
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

const buildArchiveVodUrl = (vodId) =>
  config.archiveSiteUrl ? `${config.archiveSiteUrl}/#/youtube/${encodeURIComponent(String(vodId))}` : "";

const toNonNegativeInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  if (rounded < 0) return null;
  return rounded;
};

const formatYouTubeChapterTimestamp = (seconds) => {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
};

const buildYouTubeCategoryChapterLines = ({ chapters = [], partNumber, youtubeParts = [] }) => {
  const normalizedChapters = (Array.isArray(chapters) ? chapters : [])
    .map((chapter, index) => {
      const start = toNonNegativeInteger(chapter?.start);
      if (start === null) return null;
      const duration = toNonNegativeInteger(chapter?.end);
      const fallbackName = `Category ${index + 1}`;
      const name = sanitizeTitle(chapter?.name || fallbackName) || fallbackName;
      return {
        start,
        duration,
        name,
        index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.index - b.index));

  if (normalizedChapters.length === 0) return [];

  const normalizedParts = (Array.isArray(youtubeParts) ? youtubeParts : [])
    .filter((part) => toNonNegativeInteger(part?.part) !== null)
    .map((part, index) => ({
      part: toNonNegativeInteger(part?.part),
      duration: toNonNegativeInteger(part?.duration),
      index,
    }))
    .filter((part) => part.part !== null)
    .sort((a, b) => (a.part !== b.part ? a.part - b.part : a.index - b.index));

  const numericPartNumber = toNonNegativeInteger(partNumber) || 1;
  let partStartSeconds = 0;
  let partDurationSeconds = null;
  let matchedPart = normalizedParts.length === 0;

  if (normalizedParts.length > 0) {
    let runningSeconds = 0;
    for (const part of normalizedParts) {
      if (part.part === numericPartNumber) {
        partStartSeconds = runningSeconds;
        partDurationSeconds = part.duration;
        matchedPart = true;
        break;
      }

      if (part.duration === null) {
        return [];
      }
      runningSeconds += part.duration;
    }
  }
  if (!matchedPart) return [];

  const partEndSeconds = Number.isFinite(partDurationSeconds) && partDurationSeconds > 0 ? partStartSeconds + partDurationSeconds : Infinity;
  const byTimestamp = new Map();

  for (let index = 0; index < normalizedChapters.length; index++) {
    const chapter = normalizedChapters[index];
    const nextChapter = normalizedChapters[index + 1] || null;

    let chapterEnd = chapter.duration !== null && chapter.duration > 0 ? chapter.start + chapter.duration : null;
    if (nextChapter && (!Number.isFinite(chapterEnd) || chapterEnd > nextChapter.start)) {
      chapterEnd = nextChapter.start;
    }
    if (!Number.isFinite(chapterEnd) || chapterEnd <= chapter.start) {
      chapterEnd = chapter.start + 1;
    }

    if (chapterEnd <= partStartSeconds) continue;
    if (chapter.start >= partEndSeconds) continue;

    const clampedStart = Math.max(chapter.start, partStartSeconds);
    const localStart = clampedStart - partStartSeconds;
    if (!byTimestamp.has(localStart)) {
      byTimestamp.set(localStart, chapter.name);
    }
  }

  const chapterMarkers = [...byTimestamp.entries()]
    .map(([start, name]) => ({ start, name }))
    .sort((a, b) => a.start - b.start);

  if (chapterMarkers.length === 0) return [];
  if (chapterMarkers[0].start > 0) {
    chapterMarkers.unshift({
      start: 0,
      name: chapterMarkers[0].name,
    });
  }

  return chapterMarkers.map((marker) => `${formatYouTubeChapterTimestamp(marker.start)} ${marker.name}`);
};

const buildYouTubeDescription = ({ twitchVodId, streamTitle, streamDate, partNumber, totalParts, youtubeParts = [], chapters = [] }) => {
  const archiveVodUrl = buildArchiveVodUrl(twitchVodId);
  const lines = [
    archiveVodUrl ? `Chat Replay: ${archiveVodUrl}` : "Chat Replay: unavailable",
    `Original VOD: https://www.twitch.tv/videos/${twitchVodId}`,
    `Stream Title: ${sanitizeTitle(streamTitle) || `Twitch VOD ${twitchVodId}`}`,
    `Stream Date: ${formatDateDescription(streamDate)}`,
  ];

  if (totalParts > 1) {
    lines.push(`Part ${partNumber} of ${totalParts}`);
    if (youtubeParts.length > 1) {
      lines.push("");
      lines.push("Parts:");
      for (const part of [...youtubeParts].sort((a, b) => (a.part || 0) - (b.part || 0))) {
        lines.push(`PART ${part.part}: https://www.youtube.com/watch?v=${part.id}`);
      }
    }
  }

  const chapterLines = buildYouTubeCategoryChapterLines({
    chapters,
    partNumber,
    youtubeParts,
  });
  if (chapterLines.length > 0) {
    lines.push("");
    lines.push("Categories:");
    lines.push(...chapterLines);
  }

  lines.push("");
  lines.push("#vrchat #dance #vtuber #vr #virtualreality");

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

const fetchTwitchVodById = async (accessToken, vodId) => {
  const url = new URL("https://api.twitch.tv/helix/videos");
  url.searchParams.set("id", String(vodId));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    fail(`Unable to fetch Twitch VOD ${vodId} (${response.status})`);
  }

  const data = await response.json();
  return data?.data?.[0] || null;
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

const sanitizeFilenamePart = (value) =>
  String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "recording";

const buildTrack1UploadCopyPath = (recordingFile) => {
  const parsed = path.parse(recordingFile.path);
  const safeBase = sanitizeFilenamePart(parsed.name);
  const stamp = new Date(recordingFile.modifiedAtMs || Date.now()).toISOString().replace(/[:.]/g, "-");
  return path.join(config.tmpDir, "youtube-upload-audio1", `${safeBase}.${stamp}.track1.mkv`);
};

const createYouTubeUploadCopyTrack1 = async (recordingFile) => {
  const outputPath = buildTrack1UploadCopyPath(recordingFile);
  await ensureDirectory(path.dirname(outputPath));
  if (await fileExists(outputPath)) {
    await fs.rm(outputPath, { force: true });
  }

  log(`Preparing YouTube upload copy (audio track 1 only): ${recordingFile.path}`);
  const ffmpegArgs = [
    "-y",
    "-i",
    recordingFile.path,
    "-map",
    "0:v?",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-c",
    "copy",
    outputPath,
  ];

  const command = spawnSync(config.ffmpegPath, ffmpegArgs, {
    stdio: "inherit",
  });

  if (command.error) {
    fail(`Failed to run ffmpeg (${config.ffmpegPath}): ${command.error.message}`);
  }

  if (command.status !== 0 || !(await fileExists(outputPath))) {
    fail(
      `Failed to create YouTube upload copy (track 1 only) for ${recordingFile.name}` +
        (Number.isFinite(command.status) ? ` (ffmpeg exit code ${command.status})` : "")
    );
  }

  const stat = await fs.stat(outputPath);
  return {
    path: outputPath,
    name: path.basename(outputPath),
    size: stat.size,
    modifiedAtMs: stat.mtimeMs,
    originalPath: recordingFile.path,
    generatedForYouTubeUploadOnly: true,
  };
};

const cleanupStaleTrack1UploadCopies = async () => {
  const tempDir = path.join(config.tmpDir, "youtube-upload-audio1");
  if (!(await fileExists(tempDir))) return;

  const entries = await fs.readdir(tempDir, { withFileTypes: true });
  const nowMs = Date.now();
  const staleAgeMs = 12 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".track1.mkv")) continue;

    const fullPath = path.join(tempDir, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (nowMs - stat.mtimeMs < staleAgeMs) continue;
      await fs.rm(fullPath, { force: true });
      log(`Removed stale temporary YouTube upload copy: ${fullPath}`);
    } catch (error) {
      log(`Failed to remove stale temp upload copy ${fullPath}: ${error.message}`);
    }
  }
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

const uploadRecordingToYouTube = async ({ youtube, recordingFile, title, description, onProgress }) => {
  log(`Uploading to YouTube: ${recordingFile.path}`);
  const totalBytes = Number(recordingFile.size || 0);
  let uploadedBytes = 0;
  let lastReportedPercent = -1;
  let lastReportedAt = 0;
  const mediaBody = fsSync.createReadStream(recordingFile.path);

  if (typeof onProgress === "function" && totalBytes > 0) {
    mediaBody.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      const percent = Math.max(0, Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)));
      const now = Date.now();
      if (percent === lastReportedPercent && now - lastReportedAt < 800) return;
      if (percent < 100 && lastReportedPercent >= 0 && percent < lastReportedPercent) return;
      lastReportedPercent = percent;
      lastReportedAt = now;
      onProgress({
        uploadedBytes,
        totalBytes,
        percent,
      });
    });
  }

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
      body: mediaBody,
    },
  });

  if (typeof onProgress === "function" && totalBytes > 0) {
    onProgress({
      uploadedBytes: totalBytes,
      totalBytes,
      percent: 100,
    });
  }

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

const setYouTubeVideoPrivacyStatus = async (youtube, videoId, privacyStatus) => {
  const response = await youtube.videos.list({
    part: ["status"],
    id: [videoId],
  });
  const item = response.data.items?.[0];
  if (!item?.status) return false;

  if (String(item.status.privacyStatus || "").toLowerCase() === String(privacyStatus || "").toLowerCase()) {
    return true;
  }

  const nextStatus = {
    privacyStatus,
  };

  if (typeof item.status.license === "string") nextStatus.license = item.status.license;
  if (typeof item.status.embeddable === "boolean") nextStatus.embeddable = item.status.embeddable;
  if (typeof item.status.publicStatsViewable === "boolean") nextStatus.publicStatsViewable = item.status.publicStatsViewable;
  if (typeof item.status.publishAt === "string" && item.status.publishAt) nextStatus.publishAt = item.status.publishAt;
  if (Object.prototype.hasOwnProperty.call(item.status, "selfDeclaredMadeForKids")) {
    nextStatus.selfDeclaredMadeForKids = Boolean(item.status.selfDeclaredMadeForKids);
  }

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: nextStatus,
    },
  });

  return true;
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
      chapters: vodEntry.chapters,
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

const MATCH_WINDOW_BEFORE_VOD_START_MS = 15 * 60 * 1000;
const MATCH_WINDOW_AFTER_VOD_END_MS = 60 * 60 * 1000;

const probeMediaDurationSeconds = (filePath) => {
  const probe = spawnSync(
    config.ffprobePath,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf8" }
  );

  if (probe.status !== 0) {
    return null;
  }

  const parsed = Number.parseFloat(String(probe.stdout || "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const enrichRecordingTiming = (recordingFile) => {
  const durationSeconds = probeMediaDurationSeconds(recordingFile.path);
  const endAtMs = Number(recordingFile.modifiedAtMs);
  const durationMs = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null;
  const startAtMs = Number.isFinite(durationMs) ? Math.max(0, endAtMs - durationMs) : null;

  return {
    ...recordingFile,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    startAtMs,
    endAtMs,
  };
};

const selectMatchingVod = (recordingFile, twitchVods) => {
  if (twitchVods.length === 0) return null;
  const recordingStartMs = Number.isFinite(recordingFile.startAtMs) ? recordingFile.startAtMs : Number(recordingFile.modifiedAtMs);
  const recordingEndMs = Number.isFinite(recordingFile.endAtMs) ? recordingFile.endAtMs : Number(recordingFile.modifiedAtMs);
  const hasAccurateStartTime = Number.isFinite(recordingFile.startAtMs);
  const candidates = twitchVods
    .map((vod) => {
      const vodStartMs = new Date(vod.created_at).getTime();
      if (!Number.isFinite(vodStartMs)) return null;

      const vodDurationSeconds = parseTwitchDurationToSeconds(vod.duration);
      const vodEndMs = vodStartMs + Math.max(0, vodDurationSeconds * 1000);
      const earliestMatchMs = vodStartMs - MATCH_WINDOW_BEFORE_VOD_START_MS;
      const latestMatchMs = vodEndMs + MATCH_WINDOW_AFTER_VOD_END_MS;

      // Require overlap with this VOD lifecycle and reject recordings that start too far
      // after this VOD ended (prevents cross-day recordings from becoming parts).
      if (recordingEndMs < earliestMatchMs || recordingStartMs > latestMatchMs) return null;

      // Prefer start-time alignment when available; otherwise fall back to end alignment.
      const anchorMs = hasAccurateStartTime ? vodStartMs : vodEndMs;
      const recordingAnchorMs = hasAccurateStartTime ? recordingStartMs : recordingEndMs;
      return {
        vod,
        deltaMs: Math.abs(anchorMs - recordingAnchorMs),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deltaMs - b.deltaMs);

  const best = candidates[0];
  if (!best) return null;
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

const parseArchiveDurationToSeconds = (durationText) => {
  const normalized = String(durationText || "").trim();
  const hms = normalized.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)$/);
  if (hms) {
    const hours = Number(hms[1] || "0");
    const minutes = Number(hms[2] || "0");
    const seconds = Number(hms[3] || "0");
    return hours * 3600 + minutes * 60 + seconds;
  }
  return parseTwitchDurationToSeconds(normalized);
};

const normalizeMergeTitle = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/[\W_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const dedupeBy = (items, getKey) => {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = String(getKey(item) || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
};

const pruneShortArchiveVods = (vods, minimumDurationSeconds) => {
  const keep = [];
  const removedVodIds = [];
  for (const vod of Array.isArray(vods) ? vods : []) {
    const durationSeconds = parseArchiveDurationToSeconds(vod?.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds < minimumDurationSeconds) {
      removedVodIds.push(String(vod?.id || ""));
      continue;
    }
    keep.push(vod);
  }
  return { vods: keep, removedVodIds: removedVodIds.filter(Boolean) };
};

const mergeAdjacentArchiveVods = (vods, maxGapMs) => {
  const sorted = [...(Array.isArray(vods) ? vods : [])].sort(
    (a, b) => new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()
  );

  if (sorted.length <= 1) return { vods: sorted, mergedGroups: [] };

  const MERGE_OVERLAP_TOLERANCE_MS = 15 * 60 * 1000;
  const grouped = [];
  let currentGroup = [sorted[0]];

  const shouldMerge = (left, right) => {
    const leftTitle = normalizeMergeTitle(left?.title);
    const rightTitle = normalizeMergeTitle(right?.title);
    if (!leftTitle || !rightTitle || leftTitle !== rightTitle) return false;

    const leftStartMs = new Date(left?.createdAt || 0).getTime();
    const rightStartMs = new Date(right?.createdAt || 0).getTime();
    if (!Number.isFinite(leftStartMs) || !Number.isFinite(rightStartMs)) return false;

    const leftDurationSeconds = parseArchiveDurationToSeconds(left?.duration);
    if (!Number.isFinite(leftDurationSeconds) || leftDurationSeconds <= 0) return false;

    const leftEndMs = leftStartMs + Math.round(leftDurationSeconds * 1000);
    const gapMs = rightStartMs - leftEndMs;
    return gapMs <= maxGapMs && gapMs >= -MERGE_OVERLAP_TOLERANCE_MS;
  };

  const flushGroup = () => {
    if (currentGroup.length > 0) {
      grouped.push(currentGroup);
      currentGroup = [];
    }
  };

  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index];
    const previous = currentGroup[currentGroup.length - 1];
    if (shouldMerge(previous, current)) {
      currentGroup.push(current);
    } else {
      flushGroup();
      currentGroup = [current];
    }
  }
  flushGroup();

  const mergedGroups = [];
  const mergedVods = grouped.map((group) => {
    if (group.length === 1) return group[0];

    const orderedGroup = [...group].sort(
      (a, b) => new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()
    );
    const primary = orderedGroup[0];
    const totalDurationSeconds = orderedGroup.reduce(
      (total, vod) => total + Math.max(0, parseArchiveDurationToSeconds(vod?.duration)),
      0
    );

    const youtubePartsInOrder = [];
    for (const vod of orderedGroup) {
      const parts = (Array.isArray(vod?.youtube) ? vod.youtube : [])
        .filter((part) => String(part?.type || "vod") === "vod" && part?.id)
        .sort((a, b) => (Number(a?.part) || 0) - (Number(b?.part) || 0));
      youtubePartsInOrder.push(...parts);
    }

    const normalizedYoutubeParts = youtubePartsInOrder.map((part, index) => ({
      ...part,
      type: "vod",
      part: index + 1,
    }));

    const mergedDrive = dedupeBy(
      orderedGroup.flatMap((vod) => (Array.isArray(vod?.drive) ? vod.drive : [])),
      (entry) => `${entry?.type || "vod"}:${entry?.id || ""}`
    );

    const mergedChapters = [];
    let chapterOffsetSeconds = 0;
    for (const vod of orderedGroup) {
      const chapters = Array.isArray(vod?.chapters) ? vod.chapters : [];
      for (const chapter of chapters) {
        const chapterStart = Number(chapter?.start);
        const chapterEnd = Number(chapter?.end);
        mergedChapters.push({
          ...chapter,
          start: Number.isFinite(chapterStart) ? Math.max(0, Math.round(chapterStart + chapterOffsetSeconds)) : chapter?.start,
          end: Number.isFinite(chapterEnd) ? Math.max(0, Math.round(chapterEnd)) : chapter?.end,
        });
      }
      chapterOffsetSeconds += Math.max(0, parseArchiveDurationToSeconds(vod?.duration));
    }

    const merged = {
      ...primary,
      duration: totalDurationSeconds > 0 ? formatDuration(totalDurationSeconds) : primary?.duration,
      youtube: normalizedYoutubeParts.length > 0 ? normalizedYoutubeParts : Array.isArray(primary?.youtube) ? primary.youtube : [],
      drive: mergedDrive.length > 0 ? mergedDrive : Array.isArray(primary?.drive) ? primary.drive : [],
      chapters: mergedChapters.length > 0 ? mergedChapters : Array.isArray(primary?.chapters) ? primary.chapters : [],
      createdAt: orderedGroup[0]?.createdAt || primary?.createdAt,
      updatedAt: new Date().toISOString(),
    };

    if (orderedGroup.some((vod) => vod?.chatReplayAvailable === false)) merged.chatReplayAvailable = false;
    if (!merged?.vodNotice) {
      merged.vodNotice = orderedGroup.map((vod) => vod?.vodNotice).find(Boolean);
    }
    if (orderedGroup.every((vod) => vod?.unpublished === true)) merged.unpublished = true;

    const secondaryIds = orderedGroup
      .slice(1)
      .map((vod) => String(vod?.id || ""))
      .filter(Boolean);
    if (secondaryIds.length > 0) {
      mergedGroups.push({
        primaryId: String(primary?.id || ""),
        mergedIds: secondaryIds,
      });
    }

    return merged;
  });

  mergedVods.sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());
  return { vods: mergedVods, mergedGroups };
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

const runPipeline = async () => {
  await validateConfiguration();
  await ensureDirectory(path.dirname(config.vodsDataPath));
  await ensureDirectory(config.commentsDir);
  await ensureDirectory(config.emotesDir);
  await ensureDirectory(path.dirname(config.statePath));
  await ensureDirectory(config.tmpDir);
  await cleanupStaleTrack1UploadCopies();

  const state = await readJsonFile(config.statePath, {
    processedFiles: {},
    processedVodIds: {},
  });
  if (!state.processedFiles || typeof state.processedFiles !== "object") state.processedFiles = {};
  if (!state.processedVodIds || typeof state.processedVodIds !== "object") state.processedVodIds = {};
  const persistState = async () => {
    if (config.dryRun) return;
    await writeJsonFile(config.statePath, state);
  };

  const existingVods = await readJsonFile(config.vodsDataPath, []);
  const stagedPaths = [];
  let vodsUpdated = false;

  const minimumArchiveVodDurationSeconds = Math.max(1, Math.floor(Number(config.minArchiveVodDurationSeconds) || 300));
  const archiveMergeGapMs = Math.max(0, Math.floor(Number(config.autoMergeVodGapSeconds) || 3600) * 1000);

  const { vods: vodsWithoutShorts, removedVodIds: removedShortVodIds } = pruneShortArchiveVods(
    existingVods,
    minimumArchiveVodDurationSeconds
  );
  const { vods: mergedArchiveVods, mergedGroups } = mergeAdjacentArchiveVods(vodsWithoutShorts, archiveMergeGapMs);

  const archiveMaintenanceChanged = removedShortVodIds.length > 0 || mergedGroups.length > 0;
  if (archiveMaintenanceChanged) {
    existingVods.splice(0, existingVods.length, ...mergedArchiveVods);
    vodsUpdated = true;

    if (removedShortVodIds.length > 0) {
      log(
        `Removed ${removedShortVodIds.length} archived VOD${removedShortVodIds.length === 1 ? "" : "s"} shorter than ${Math.floor(
          minimumArchiveVodDurationSeconds / 60
        )} minute(s): ${removedShortVodIds.join(", ")}`
      );
    }

    if (mergedGroups.length > 0) {
      for (const group of mergedGroups) {
        log(`Merged adjacent VODs into ${group.primaryId}: ${group.mergedIds.join(", ")}`);
      }
    }

    if (!config.dryRun) {
      for (const vodId of removedShortVodIds) {
        const commentsPath = path.join(config.commentsDir, `${vodId}.json`);
        const emotesPath = path.join(config.emotesDir, `${vodId}.json`);
        if (await fileExists(commentsPath)) {
          await fs.rm(commentsPath, { force: true });
          stagedPaths.push(commentsPath);
        }
        if (await fileExists(emotesPath)) {
          await fs.rm(emotesPath, { force: true });
          stagedPaths.push(emotesPath);
        }
        if (state.processedVodIds && Object.prototype.hasOwnProperty.call(state.processedVodIds, vodId)) {
          delete state.processedVodIds[vodId];
        }
      }
    }
  }

  const now = Date.now();
  let staleProcessingEntriesCleared = 0;
  for (const [filePath, entry] of Object.entries(state.processedFiles)) {
    const status = String(entry?.status || "");
    if (!ACTIVE_PROCESSED_FILE_STATUSES.has(status)) continue;

    const updatedAtMs = parseTimestampMs(entry?.updatedAt) || parseTimestampMs(entry?.startedAt) || 0;
    const isStale = !updatedAtMs || now - updatedAtMs > PROCESSING_RECORD_STALE_AFTER_MS;
    if (!isStale) continue;

    delete state.processedFiles[filePath];
    staleProcessingEntriesCleared += 1;
    log(`Cleared stale in-progress upload marker for ${path.basename(filePath)}`);
  }
  if (staleProcessingEntriesCleared > 0) {
    await persistState();
  }

  const minAgeMs = config.minRecordingAgeMinutes * 60 * 1000;
  const recordings = (await listRecordingFiles(config.recordingsDir))
    .filter((file) => now - file.modifiedAtMs >= minAgeMs)
    .filter((file) => {
      const status = String(state.processedFiles?.[file.path]?.status || "");
      if (TERMINAL_PROCESSED_FILE_STATUSES.has(status)) return false;
      if (ACTIVE_PROCESSED_FILE_STATUSES.has(status)) return false;
      return true;
    })
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

  if (recordings.length === 0 && missingEmoteVodIds.length === 0 && vodsNeedingMetadataSync.length === 0 && !archiveMaintenanceChanged) {
    log("No completed recordings ready for processing.");
    return;
  }

  if (recordings.length === 0 && missingEmoteVodIds.length === 0 && vodsNeedingMetadataSync.length === 0 && archiveMaintenanceChanged) {
    if (config.dryRun) {
      log("[DRY RUN] Archive maintenance detected but no files were written.");
      return;
    }

    await writeJsonFile(config.vodsDataPath, existingVods);
    stagedPaths.push(config.vodsDataPath);
    await writeJsonFile(config.statePath, state);

    if (config.autoGitPush && stagedPaths.length > 0) {
      stageAndPushArchiveData(stagedPaths, "chore: maintain archive vod data");
    }

    log("Applied archive maintenance updates.");
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
    const enrichedRecording = enrichRecordingTiming(recording);
    if (!Number.isFinite(enrichedRecording.durationSeconds) || enrichedRecording.durationSeconds <= 0) {
      log(`Skipping recording "${recording.name}" because duration could not be determined.`);

      if (!config.dryRun) {
        state.processedFiles[recording.path] = {
          status: "ignored_unknown_duration",
          processedAt: new Date().toISOString(),
        };
        await persistState();
      }
      continue;
    }

    if (
      Number.isFinite(enrichedRecording.durationSeconds) &&
      enrichedRecording.durationSeconds > 0 &&
      enrichedRecording.durationSeconds < minimumArchiveVodDurationSeconds
    ) {
      const durationText = formatDuration(Math.max(0, Math.floor(enrichedRecording.durationSeconds)));
      log(
        `Skipping short recording "${recording.name}" (${durationText}) below minimum archive duration of ${Math.floor(
          minimumArchiveVodDurationSeconds / 60
        )} minute(s).`
      );

      if (!config.dryRun) {
        state.processedFiles[recording.path] = {
          status: "ignored_short",
          durationSeconds: Math.floor(enrichedRecording.durationSeconds),
          processedAt: new Date().toISOString(),
        };
        await persistState();
      }
      continue;
    }

    const matchedVod = selectMatchingVod(enrichedRecording, twitchVods);
    if (!matchedVod) {
      log(`No Twitch VOD match found for recording: ${recording.name}`);
      continue;
    }
    plannedUploads.push({ recording: enrichedRecording, twitchVod: matchedVod });
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
    let twitchVod = uploads[0].twitchVod;
    try {
      const latestTwitchVod = await fetchTwitchVodById(twitchAccessToken, vodId);
      if (latestTwitchVod) {
        twitchVod = { ...twitchVod, ...latestTwitchVod };
      }
    } catch (error) {
      log(`Failed to refresh Twitch metadata for VOD ${vodId} before upload: ${error.message}`);
    }
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

      let currentStreamTitle = twitchVod.title || path.parse(recording.name).name;
      let currentStreamDate = twitchVod.created_at;
      let currentTitle = "";
      let currentDescription = "";
      const rebuildUploadMetadata = () => {
        currentTitle = buildYouTubeTitle({
          streamTitle: currentStreamTitle || path.parse(recording.name).name,
          streamDate: currentStreamDate,
          partNumber,
          totalParts: totalPartsAfterUpload,
        });
        currentDescription = buildYouTubeDescription({
          twitchVodId: vodId,
          streamTitle: currentStreamTitle,
          streamDate: currentStreamDate,
          partNumber,
          totalParts: totalPartsAfterUpload,
          youtubeParts: [],
          chapters: vodEntry.chapters,
        });
      };
      rebuildUploadMetadata();

      let uploadRecording = null;
      const uploadSessionCreatedAtMs = Date.now();
      const uploadSessionId = `twitch-${vodId}-part-${partNumber}-${uploadSessionCreatedAtMs}`;
      const buildUploadSessionBase = () => ({
        sessionId: uploadSessionId,
        twitchVodId: String(vodId),
        partNumber,
        title: currentTitle,
        recordingName: recording.name,
        streamDate: currentStreamDate || null,
        createdAtMs: uploadSessionCreatedAtMs,
      });
      let latestProgress = {
        percent: 0,
        uploadedBytes: 0,
        totalBytes: 0,
      };
      let lastRealtimeUploadProgressPercent = -1;
      let lastRealtimeUploadProgressAtMs = 0;
      let lastTwitchMetadataRefreshAtMs = 0;
      let twitchMetadataRefreshInFlight = false;

      const maybeRefreshTwitchUploadMetadata = async (force = false) => {
        const nowMs = Date.now();
        if (!force && nowMs - lastTwitchMetadataRefreshAtMs < 45_000) return false;
        lastTwitchMetadataRefreshAtMs = nowMs;

        const latestTwitchVod = await fetchTwitchVodById(twitchAccessToken, vodId);
        if (!latestTwitchVod) return false;

        twitchVod = { ...twitchVod, ...latestTwitchVod };
        const nextStreamTitle = latestTwitchVod.title || currentStreamTitle;
        const nextStreamDate = latestTwitchVod.created_at || currentStreamDate;
        const metadataChanged = nextStreamTitle !== currentStreamTitle || nextStreamDate !== currentStreamDate;

        currentStreamTitle = nextStreamTitle;
        currentStreamDate = nextStreamDate;
        rebuildUploadMetadata();

        vodEntry.title = currentStreamTitle;
        if (currentStreamDate) vodEntry.createdAt = currentStreamDate;
        if (latestTwitchVod.stream_id) vodEntry.stream_id = latestTwitchVod.stream_id;

        return metadataChanged;
      };

      try {
        if (!config.dryRun) {
          const nowIso = new Date().toISOString();
          state.processedFiles[recording.path] = {
            status: "processing",
            twitchVodId: vodId,
            part: partNumber,
            startedAt: nowIso,
            updatedAt: nowIso,
          };
          await persistState();
        }

        try {
          await maybeRefreshTwitchUploadMetadata(true);
        } catch (error) {
          log(`Failed to refresh Twitch metadata for upload ${vodId} part ${partNumber}: ${error.message}`);
        }

        await writeObsDockUploadStatus({
          visible: true,
          state: "preparing",
          message: `Preparing VOD upload copy (track 1 audio)`,
          percent: 0,
        });
        await postRealtimeUploadStatus({
          ...buildUploadSessionBase(),
          state: "preparing",
          message: "Preparing VOD upload copy (track 1 audio)",
          percent: 0,
          uploadedBytes: 0,
          totalBytes: recording.size || null,
        });
        uploadRecording = await createYouTubeUploadCopyTrack1(recording);
        latestProgress.totalBytes = Number(uploadRecording.size || 0);

        const insertedTitle = currentTitle;
        const insertedDescription = currentDescription;
        const youtubeVideoId = await uploadRecordingToYouTube({
          youtube,
          recordingFile: uploadRecording,
          title: insertedTitle,
          description: insertedDescription,
          onProgress: ({ percent, uploadedBytes, totalBytes }) => {
            latestProgress = {
              percent: Number.isFinite(percent) ? percent : latestProgress.percent,
              uploadedBytes: Number.isFinite(uploadedBytes) ? uploadedBytes : latestProgress.uploadedBytes,
              totalBytes: Number.isFinite(totalBytes) ? totalBytes : latestProgress.totalBytes,
            };
            void writeObsDockUploadStatus({
              visible: true,
              state: "uploading",
              message: "Uploading VOD",
              percent: Number.isFinite(percent) ? percent : null,
              uploaded_bytes: Number.isFinite(uploadedBytes) ? Math.max(0, Math.floor(uploadedBytes)) : null,
              total_bytes: Number.isFinite(totalBytes) ? Math.max(0, Math.floor(totalBytes)) : null,
            });

            const nowMs = Date.now();
            const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : null;
            if (
              safePercent != null &&
              (safePercent !== lastRealtimeUploadProgressPercent || nowMs - lastRealtimeUploadProgressAtMs >= 4000)
            ) {
              lastRealtimeUploadProgressPercent = safePercent;
              lastRealtimeUploadProgressAtMs = nowMs;
              void postRealtimeUploadStatus({
                ...buildUploadSessionBase(),
                state: "uploading",
                message: "Uploading VOD",
                percent: safePercent,
                uploadedBytes: Number.isFinite(uploadedBytes) ? Math.floor(uploadedBytes) : null,
                totalBytes: Number.isFinite(totalBytes) ? Math.floor(totalBytes) : null,
              });
            }

            if (!twitchMetadataRefreshInFlight && nowMs - lastTwitchMetadataRefreshAtMs >= 45_000) {
              twitchMetadataRefreshInFlight = true;
              void (async () => {
                try {
                  const changed = await maybeRefreshTwitchUploadMetadata(true);
                  if (!changed) return;

                  await postRealtimeUploadStatus({
                    ...buildUploadSessionBase(),
                    state: "uploading",
                    message: "Uploading VOD",
                    percent: Number.isFinite(latestProgress.percent)
                      ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent)))
                      : null,
                    uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
                    totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
                  });
                } catch (error) {
                  log(`Failed to refresh Twitch metadata for active upload ${vodId}: ${error.message}`);
                } finally {
                  twitchMetadataRefreshInFlight = false;
                }
              })();
            }
          },
        });

        let refreshedAfterUpload = false;
        try {
          refreshedAfterUpload = await maybeRefreshTwitchUploadMetadata(true);
        } catch (error) {
          log(`Failed to refresh Twitch metadata after upload ${vodId} part ${partNumber}: ${error.message}`);
        }

        if (refreshedAfterUpload && (currentTitle !== insertedTitle || currentDescription !== insertedDescription)) {
          try {
            await updateYouTubeVideoMetadata(youtube, youtubeVideoId, {
              title: currentTitle,
              description: currentDescription,
            });
          } catch (error) {
            log(`Failed to update YouTube metadata after title refresh for ${youtubeVideoId}: ${error.message}`);
          }
        }

        await postRealtimeUploadStatus({
          ...buildUploadSessionBase(),
          state: "finalizing",
          message: "Finalizing archive metadata",
          percent: 100,
          uploadedBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          youtubeVideoId,
        });
        await writeObsDockUploadStatus({
          visible: true,
          state: "done",
          message: "VOD upload done",
          percent: 100,
          hide_after_ms: 10000,
        });
        const details = await fetchYouTubeVideoDetails(youtube, youtubeVideoId);

        if (
          Number.isFinite(details.durationSeconds) &&
          details.durationSeconds > 0 &&
          details.durationSeconds < minimumArchiveVodDurationSeconds
        ) {
          try {
            await setYouTubeVideoPrivacyStatus(youtube, youtubeVideoId, "unlisted");
          } catch (privacyError) {
            log(`Failed to unlist short YouTube part ${youtubeVideoId}: ${privacyError.message}`);
          }

          state.processedFiles[recording.path] = {
            status: "ignored_short_uploaded",
            twitchVodId: vodId,
            youtubeVideoId,
            part: partNumber,
            durationSeconds: details.durationSeconds,
            processedAt: new Date().toISOString(),
          };
          await persistState();

          await postRealtimeUploadStatus({
            ...buildUploadSessionBase(),
            state: "done",
            message: `Skipped short part (${details.durationSeconds}s); set video to unlisted`,
            percent: 100,
            uploadedBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
            totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
            youtubeVideoId,
          });

          log(
            `Skipped archiving short uploaded part for Twitch VOD ${vodId}: ${youtubeVideoId} (${details.durationSeconds}s)`
          );
          continue;
        }

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
        await persistState();

        await postRealtimeUploadStatus({
          ...buildUploadSessionBase(),
          state: "done",
          message: "VOD upload complete",
          percent: 100,
          uploadedBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          youtubeVideoId,
        });

        log(`Completed pipeline for Twitch VOD ${vodId} -> YouTube ${youtubeVideoId} (Part ${partNumber})`);
      } catch (error) {
        if (!config.dryRun) {
          state.processedFiles[recording.path] = {
            ...state.processedFiles[recording.path],
            status: "error",
            twitchVodId: vodId,
            part: partNumber,
            updatedAt: new Date().toISOString(),
            error: error.message,
          };
          await persistState();
        }
        await postRealtimeUploadStatus({
          ...buildUploadSessionBase(),
          state: "error",
          message: `Upload failed: ${error.message}`,
          percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : null,
          uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
          totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
        });
        throw error;
      } finally {
        if (uploadRecording?.generatedForYouTubeUploadOnly && uploadRecording.path) {
          try {
            await fs.rm(uploadRecording.path, { force: true });
          } catch (error) {
            log(`Failed to remove temporary upload copy ${uploadRecording.path}: ${error.message}`);
          }
        }
      }
    }

    try {
      const latestTwitchVod = await fetchTwitchVodById(twitchAccessToken, vodId);
      if (latestTwitchVod) {
        vodEntry.title = latestTwitchVod.title || vodEntry.title;
        vodEntry.createdAt = latestTwitchVod.created_at || vodEntry.createdAt;
        if (latestTwitchVod.stream_id) vodEntry.stream_id = latestTwitchVod.stream_id;
      }
    } catch (error) {
      log(`Failed to refresh Twitch metadata before final sync for VOD ${vodId}: ${error.message}`);
    }

    await syncYouTubeMetadataForVod(youtube, vodEntry);
    upsertVod(existingVods, vodEntry);
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

const run = async () => {
  const releaseRunLock = await acquirePipelineRunLock(config.runLockPath);
  if (!releaseRunLock) {
    log("Another local archive pipeline run is already active. Skipping this invocation.");
    return;
  }

  try {
    await runPipeline();
  } finally {
    await releaseRunLock();
  }
};

run()
  .then(async () => {
    log("Local archive pipeline finished.");
  })
  .catch(async (error) => {
    try {
      await writeObsDockUploadStatus({
        visible: true,
        state: "error",
        message: `VOD upload error: ${error.message}`,
        percent: null,
        hide_after_ms: 0,
      });
    } catch {}
    console.error(error);
    process.exit(1);
  });
