import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { Transform } from "stream";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";
import dotenv from "dotenv";
import { google } from "googleapis";
import {
  appendSoftuchiveSummary,
  ensureSoftuchiveStateFiles,
  readSoftuchiveControl,
  readSoftuchiveRuntime,
  readSoftuchiveSettings,
  resolveSoftuchivePaths,
  writeSoftuchiveControl,
  writeSoftuchiveRuntime,
} from "./softuchive_state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const cliArgValues = process.argv.slice(2);
const cliArgs = new Set(cliArgValues);
const syncMetadataOnlyMode = cliArgs.has("--sync-metadata-only");
const syncYouTubeVisibilityOnlyMode = cliArgs.has("--sync-youtube-visibility-only");
const triggerArg = cliArgValues.find((arg) => arg.startsWith("--trigger=")) || "";
const pipelineTrigger = String(triggerArg.split("=").slice(1).join("=") || "manual")
  .trim()
  .toLowerCase();

const METADATA_TEMPLATE_VERSION = 8;
const DEFAULT_ARCHIVE_SITE_URL = "https://softu.one";
const DEFAULT_GIT_COMMIT_AUTHOR_NAME = "softu archive bot";
const DEFAULT_GIT_COMMIT_AUTHOR_EMAIL = "archive-bot@softu.one";
const DEFAULT_WINDOWS_RECORDINGS_DIR = "D:\\Stream Archives";
const CHAT_BACKFILL_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

const resolveDefaultRecordingsDir = () => {
  const configured = String(process.env.LOCAL_RECORDINGS_DIR || "").trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
  }
  if (process.platform === "win32") return DEFAULT_WINDOWS_RECORDINGS_DIR;
  return path.join(repoRoot, "recordings");
};

const resolveConfiguredBinaryPath = (configuredValue) => {
  const raw = String(configuredValue || "").trim();
  if (!raw) return "";

  const looksLikeCommandName = !path.isAbsolute(raw) && !raw.includes("/") && !raw.includes("\\");
  if (looksLikeCommandName) return raw;

  const resolved = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  if (fsSync.existsSync(resolved)) return resolved;
  return "";
};

const resolvedFfmpegPath = resolveConfiguredBinaryPath(process.env.FFMPEG_PATH) || "ffmpeg";

const inferFfprobePath = (ffmpegPath = resolvedFfmpegPath) => {
  const explicit = resolveConfiguredBinaryPath(process.env.FFPROBE_PATH);
  if (explicit) return explicit;

  const parsed = path.parse(ffmpegPath);
  const lowerBase = parsed.base.toLowerCase();
  if (lowerBase.startsWith("ffmpeg")) {
    const nextName = parsed.name.replace(/ffmpeg/i, "ffprobe");
    return path.join(parsed.dir, `${nextName}${parsed.ext}`);
  }
  return "ffprobe";
};

const parseBooleanEnv = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
};

const config = {
  recordingsDir: resolveDefaultRecordingsDir(),
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
  badgesPath: process.env.ARCHIVE_BADGES_PATH || path.join(repoRoot, "public", "data", "badges.json"),
  statePath: process.env.PIPELINE_STATE_PATH || path.join(repoRoot, "scripts", ".state", "pipeline-state.json"),
  runLockPath: process.env.PIPELINE_RUN_LOCK_PATH || path.join(repoRoot, "scripts", ".state", "pipeline-run.lock.json"),
  tmpDir: process.env.PIPELINE_TMP_DIR || path.join(repoRoot, "scripts", ".tmp"),
  minRecordingAgeMinutes: Number(process.env.MIN_RECORDING_AGE_MINUTES || "10"),
  maxRecordingsPerRun: Number(process.env.MAX_RECORDINGS_PER_RUN || "1"),
  onlyUploadMostRecentVod: parseBooleanEnv(process.env.ONLY_UPLOAD_MOST_RECENT_VOD, false),
  autoGitPush: (process.env.AUTO_GIT_PUSH || "true").toLowerCase() === "true",
  gitCommitAuthorName:
    String(process.env.GIT_COMMIT_AUTHOR_NAME || process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_COMMIT_AUTHOR_NAME).trim() ||
    DEFAULT_GIT_COMMIT_AUTHOR_NAME,
  gitCommitAuthorEmail:
    String(process.env.GIT_COMMIT_AUTHOR_EMAIL || process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_COMMIT_AUTHOR_EMAIL).trim() ||
    DEFAULT_GIT_COMMIT_AUTHOR_EMAIL,
  dryRun: (process.env.LOCAL_PIPELINE_DRY_RUN || "false").toLowerCase() === "true",
  twitchDownloaderPath: process.env.TWITCHDOWNLOADER_PATH || path.join(repoRoot, "scripts", "tools", "TwitchDownloaderCLI.exe"),
  ffmpegPath: resolvedFfmpegPath,
  ffprobePath: inferFfprobePath(resolvedFfmpegPath),
  uploadStatusApiBase: inferUploadStatusApiBase(),
  uploadStatusApiSecret: process.env.UPLOAD_STATUS_API_SECRET || "",
  minArchiveVodDurationSeconds: Number(process.env.MIN_ARCHIVE_VOD_DURATION_SECONDS || "300"),
  autoMergeVodGapSeconds: Number(process.env.AUTO_MERGE_VOD_GAP_SECONDS || "3600"),
  youtubeVisibilitySyncEnabled: (process.env.YOUTUBE_VISIBILITY_SYNC_ENABLED || "true").toLowerCase() !== "false",
  youtubeVisibilitySyncIntervalMinutes: Number(process.env.YOUTUBE_VISIBILITY_SYNC_INTERVAL_MINUTES || "180"),
  youtubeArchiveVisiblePrivacyStatuses: String(process.env.YOUTUBE_ARCHIVE_VISIBLE_PRIVACY_STATUSES || "public")
    .split(",")
    .map((status) => status.trim().toLowerCase())
    .filter(Boolean),
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
  "skipped_manual",
]);
const PIPELINE_RUN_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PROCESSING_RECORD_STALE_AFTER_MS =
  Math.max(5, Number(process.env.SOFTUCHIVE_PROCESSING_STALE_AFTER_MINUTES || "30")) * 60 * 1000;
const YOUTUBE_VISIBILITY_SYNC_INTERVAL_MS =
  Math.max(15, Number(config.youtubeVisibilitySyncIntervalMinutes) || 180) * 60 * 1000;
const SOFTUCHIVE_PAUSE_ERROR_CODE = "SOFTUCHIVE_PAUSED";
const SOFTUCHIVE_SKIP_ERROR_CODE = "SOFTUCHIVE_SKIPPED";
const SOFTUCHIVE_UPLOAD_STALL_ERROR_CODE = "SOFTUCHIVE_UPLOAD_STALLED";
const SOFTUCHIVE_UPLOAD_STALL_TIMEOUT_MS = Math.max(
  45_000,
  Number(process.env.SOFTUCHIVE_UPLOAD_STALL_TIMEOUT_MS || "120000")
);
const SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS = Math.max(1, Number(process.env.SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS || "3"));

let softuchiveLogSink = null;
let softuchiveTracker = null;

const log = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (typeof softuchiveLogSink === "function") {
    void softuchiveLogSink({ timestamp, message });
  }
};

const configuredFfmpegPath = String(process.env.FFMPEG_PATH || "").trim();
if (configuredFfmpegPath && configuredFfmpegPath !== config.ffmpegPath) {
  log(`Configured FFMPEG_PATH not found at ${configuredFfmpegPath}; falling back to ${config.ffmpegPath}`);
}

const configuredFfprobePath = String(process.env.FFPROBE_PATH || "").trim();
if (configuredFfprobePath && configuredFfprobePath !== config.ffprobePath) {
  log(`Configured FFPROBE_PATH not found at ${configuredFfprobePath}; falling back to ${config.ffprobePath}`);
}

const fail = (message) => {
  throw new Error(message);
};

const gitCommitIdentityArgs = () => [
  "-c",
  `user.name=${config.gitCommitAuthorName}`,
  "-c",
  `user.email=${config.gitCommitAuthorEmail}`,
];

const toGitRepoPath = (filePath) => path.relative(repoRoot, filePath).split(path.sep).join("/");

const runGitCommand = (args, { cwd = repoRoot, allowFailure = false } = {}) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (!allowFailure && result.status !== 0) {
    const details = [stdout, stderr].filter(Boolean).join("\n");
    fail(`git ${args[0]} failed${details ? `: ${details}` : ""}`);
  }

  return {
    ...result,
    stdout,
    stderr,
  };
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

const chunkArray = (items, size) => {
  const source = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(1, Math.floor(Number(size) || 1));
  const chunks = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }
  return chunks;
};

const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  return rounded >= 1 ? rounded : null;
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

const formatStreamedDateDescription = (input) => {
  const date = new Date(input || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown";
  const monthLabels = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
  return `${monthLabels[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

const truncateYouTubeTitle = (title, maxLength = 100) => {
  const normalized = String(title || "").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const buildYouTubeTitle = ({ streamTitle }) => {
  const safeTitle = sanitizeTitle(streamTitle || "Stream");
  return truncateYouTubeTitle(safeTitle);
};

const buildArchiveVodUrl = (vodId) =>
  config.archiveSiteUrl ? `${config.archiveSiteUrl}/${encodeURIComponent(String(vodId))}` : "";

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
  const twitchChannelUrl = `https://twitch.tv/${config.twitchChannelLogin || "softuwo"}`;
  const lines = [
    `streamed ${formatStreamedDateDescription(streamDate)} \u2726 Chat replay: ${archiveVodUrl || "unavailable"}`,
    `Watch live on Twitch! ${twitchChannelUrl}`,
  ];

  const chapterLines = buildYouTubeCategoryChapterLines({
    chapters,
    partNumber,
    youtubeParts,
  });
  lines.push("");
  lines.push("Categories:");
  lines.push(...chapterLines);

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

const fetchGlobalChatBadges = async (accessToken) => {
  const response = await fetch("https://api.twitch.tv/helix/chat/badges/global", {
    method: "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) fail(`Unable to fetch global chat badges (${response.status})`);
  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
};

const fetchChannelChatBadges = async (accessToken, broadcasterId) => {
  const url = new URL("https://api.twitch.tv/helix/chat/badges");
  url.searchParams.set("broadcaster_id", String(broadcasterId || ""));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) fail(`Unable to fetch channel chat badges (${response.status})`);
  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
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

  if (softuchiveTracker) {
    await softuchiveTracker.throwIfPauseRequested("Pause requested before ffmpeg copy started.");
    await softuchiveTracker.setStage("ffmpeg", `Preparing track 1 upload copy for ${recordingFile.name}.`);
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

  await new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ffmpegArgs, {
      stdio: "inherit",
    });
    let settled = false;
    let pauseCheckInFlight = false;
    const stopPauseTimer = () => {
      if (pauseTimer) clearInterval(pauseTimer);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      stopPauseTimer();
      if (error) reject(error);
      else resolve();
    };

    const pauseTimer = setInterval(() => {
      if (!softuchiveTracker || pauseCheckInFlight || settled) return;
      pauseCheckInFlight = true;
      void (async () => {
        try {
          const pauseRequested = await softuchiveTracker.shouldPause();
          if (!pauseRequested || settled) return;
          try {
            child.kill();
          } catch {}
          finish(createPipelineControlError("Pause requested while preparing the upload copy.", SOFTUCHIVE_PAUSE_ERROR_CODE));
        } finally {
          pauseCheckInFlight = false;
        }
      })();
    }, 1000);
    if (typeof pauseTimer?.unref === "function") pauseTimer.unref();

    child.on("error", (error) => {
      finish(new Error(`Failed to run ffmpeg (${config.ffmpegPath}): ${error.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `Failed to create YouTube upload copy (track 1 only) for ${recordingFile.name}` +
              (Number.isFinite(code) ? ` (ffmpeg exit code ${code})` : "")
          )
        );
        return;
      }
      finish();
    });
  });

  if (!(await fileExists(outputPath))) {
    fail(`Failed to create YouTube upload copy (track 1 only) for ${recordingFile.name}`);
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

const buildCommentsPayload = (twitchVodId, comments, generatedAt = new Date().toISOString()) => ({
  source: "twitchdownloader",
  twitchVodId: String(twitchVodId),
  generatedAt,
  comments: Array.isArray(comments) ? comments : [],
});

const buildEmotePayload = (twitchVodId, channelEmoteSets, embeddedEmotes, generatedAt = new Date().toISOString()) => ({
  source: "local-archive-pipeline",
  twitchVodId: String(twitchVodId),
  generatedAt,
  ...channelEmoteSets,
  embedded_emotes: Array.isArray(embeddedEmotes) ? embeddedEmotes : [],
});

const buildBadgesPayload = (twitchUser, globalBadges, channelBadges, generatedAt = new Date().toISOString()) => ({
  source: "local-archive-pipeline",
  generatedAt,
  channelLogin: String(twitchUser?.login || config.twitchChannelLogin || "").trim() || null,
  channelId: String(twitchUser?.id || "").trim() || null,
  global: Array.isArray(globalBadges) ? globalBadges : [],
  channel: Array.isArray(channelBadges) ? channelBadges : [],
});

const normalizeBadgesPayloadForComparison = (payload) => ({
  channelLogin: String(payload?.channelLogin || "").trim(),
  channelId: String(payload?.channelId || "").trim(),
  global: Array.isArray(payload?.global) ? payload.global : [],
  channel: Array.isArray(payload?.channel) ? payload.channel : [],
});

const syncStaticBadges = async (accessToken, twitchUser, stagedPaths) => {
  const [globalBadges, channelBadges] = await Promise.all([
    fetchGlobalChatBadges(accessToken),
    fetchChannelChatBadges(accessToken, twitchUser?.id),
  ]);

  const nextPayload = buildBadgesPayload(twitchUser, globalBadges, channelBadges);
  const existingPayload = await readJsonFile(config.badgesPath, null);
  const existingComparable = JSON.stringify(normalizeBadgesPayloadForComparison(existingPayload));
  const nextComparable = JSON.stringify(normalizeBadgesPayloadForComparison(nextPayload));

  if (existingComparable === nextComparable) return false;

  if (config.dryRun) {
    log(
      `[DRY RUN] Would update static badge data (${channelBadges.length} channel badge sets, ${globalBadges.length} global badge sets).`
    );
    return true;
  }

  await writeJsonFile(config.badgesPath, nextPayload);
  stagedPaths.push(config.badgesPath);
  log(`Updated static badge data (${channelBadges.length} channel badge sets, ${globalBadges.length} global badge sets).`);
  return true;
};

const prepareChatArchivePayloads = async (twitchVodId, channelEmoteSets) => {
  const rawChatPath = path.join(config.tmpDir, `${twitchVodId}-chat-raw.json`);
  await downloadTwitchChatJson(twitchVodId, rawChatPath);

  const rawChat = await readJsonFile(rawChatPath, {});
  const generatedAt = new Date().toISOString();
  const comments = normalizeChatComments(rawChat);
  const embeddedEmotes = extractEmbeddedThirdPartyEmotes(rawChat);

  return {
    rawChat,
    comments,
    embeddedEmotes,
    commentsPayload: buildCommentsPayload(twitchVodId, comments, generatedAt),
    emotePayload: buildEmotePayload(twitchVodId, channelEmoteSets, embeddedEmotes, generatedAt),
  };
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

const getArchiveVisibleYouTubePrivacyStatuses = () => {
  const statuses = Array.isArray(config.youtubeArchiveVisiblePrivacyStatuses)
    ? config.youtubeArchiveVisiblePrivacyStatuses.filter(Boolean)
    : [];
  return new Set(statuses.length > 0 ? statuses : ["public"]);
};

const isYoutubeVodPartEntry = (entry) => String(entry?.type || "vod") === "vod" && Boolean(entry?.id);

const collectArchiveYouTubeVideoIds = (vods = []) => [
  ...new Set(
    (Array.isArray(vods) ? vods : [])
      .flatMap((vod) => (Array.isArray(vod?.youtube) ? vod.youtube : []))
      .filter(isYoutubeVodPartEntry)
      .map((entry) => String(entry.id).trim())
      .filter(Boolean)
  ),
];

const fetchYouTubeVideoStatusMap = async (youtube, videoIds = []) => {
  const statusById = new Map();
  const ids = [...new Set((Array.isArray(videoIds) ? videoIds : []).map((id) => String(id || "").trim()).filter(Boolean))];

  for (const batch of chunkArray(ids, 50)) {
    const response = await youtube.videos.list({
      part: ["status"],
      id: batch,
    });

    for (const item of response.data.items || []) {
      const id = String(item?.id || "").trim();
      if (!id) continue;
      statusById.set(id, {
        exists: true,
        privacyStatus: String(item?.status?.privacyStatus || "unknown").toLowerCase(),
      });
    }

    for (const id of batch) {
      if (!statusById.has(id)) {
        statusById.set(id, {
          exists: false,
          privacyStatus: "missing",
        });
      }
    }
  }

  return statusById;
};

const renumberYouTubeVodEntriesForArchive = (entries = []) => {
  const source = Array.isArray(entries) ? entries : [];
  const hasHiddenVodPart = source.some((entry) => isYoutubeVodPartEntry(entry) && entry?.unpublished === true);
  let nextPublishedPart = 1;
  let nextAdminOrder = 1;

  return source.map((entry) => {
    if (!isYoutubeVodPartEntry(entry)) return entry;

    const next = {
      ...entry,
      type: "vod",
    };

    if (hasHiddenVodPart) {
      next.adminOrder = toPositiveInt(next.adminOrder) || nextAdminOrder;
    } else {
      delete next.adminOrder;
    }
    nextAdminOrder += 1;

    if (next.unpublished === true) {
      next.part = toPositiveInt(next.part) || nextAdminOrder - 1;
    } else {
      delete next.unpublished;
      next.part = nextPublishedPart;
      nextPublishedPart += 1;
    }

    return next;
  });
};

const syncArchiveYouTubeVisibility = async (youtube, vods = []) => {
  const videoIds = collectArchiveYouTubeVideoIds(vods);
  const result = {
    checkedVideoCount: videoIds.length,
    changed: false,
    hiddenVodIds: [],
    restoredVodIds: [],
    hiddenPartIds: [],
    restoredPartIds: [],
  };

  if (videoIds.length === 0) return result;

  const visiblePrivacyStatuses = getArchiveVisibleYouTubePrivacyStatuses();
  const statusById = await fetchYouTubeVideoStatusMap(youtube, videoIds);

  for (let vodIndex = 0; vodIndex < vods.length; vodIndex += 1) {
    const vod = vods[vodIndex];
    if (!vod || !Array.isArray(vod.youtube)) continue;

    let youtubeChanged = false;
    const nextYoutube = vod.youtube.map((entry) => {
      if (!isYoutubeVodPartEntry(entry)) return entry;

      const videoId = String(entry.id).trim();
      const status = statusById.get(videoId) || { exists: false, privacyStatus: "missing" };
      const shouldBeVisible = status.exists && visiblePrivacyStatuses.has(String(status.privacyStatus || "").toLowerCase());
      const isHidden = entry?.unpublished === true;

      if (!shouldBeVisible && !isHidden) {
        youtubeChanged = true;
        result.hiddenPartIds.push(videoId);
        return {
          ...entry,
          unpublished: true,
        };
      }

      if (shouldBeVisible && isHidden) {
        youtubeChanged = true;
        result.restoredPartIds.push(videoId);
        const { unpublished, ...restoredEntry } = entry;
        return restoredEntry;
      }

      return entry;
    });

    const renumberedYoutube = renumberYouTubeVodEntriesForArchive(nextYoutube);
    if (JSON.stringify(renumberedYoutube) !== JSON.stringify(vod.youtube)) {
      youtubeChanged = true;
    }

    const vodParts = renumberedYoutube.filter(isYoutubeVodPartEntry);
    const visibleVodParts = vodParts.filter((entry) => entry?.unpublished !== true);
    const shouldHideVod = vodParts.length > 0 && visibleVodParts.length === 0;
    const isVodHidden = vod?.unpublished === true;
    const vodVisibilityChanged = shouldHideVod !== isVodHidden;

    if (!youtubeChanged && !vodVisibilityChanged) continue;

    const nextVod = {
      ...vod,
      youtube: renumberedYoutube,
      updatedAt: new Date().toISOString(),
    };

    if (shouldHideVod) {
      nextVod.unpublished = true;
      if (!isVodHidden) result.hiddenVodIds.push(String(vod.id));
    } else {
      delete nextVod.unpublished;
      if (isVodHidden) result.restoredVodIds.push(String(vod.id));
    }

    vods[vodIndex] = nextVod;
    result.changed = true;
  }

  return result;
};

const waitMs = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const normalizeUploadThrottleMbps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(10000, Math.round(parsed * 100) / 100));
};

const isSkipRequestedForUpload = (control, uploadSessionId) => {
  const requestedSessionId = String(control?.skipRequestedUploadSessionId || "").trim();
  if (!requestedSessionId) return false;
  const currentSessionId = String(uploadSessionId || "").trim();
  return requestedSessionId === "*" || (currentSessionId && requestedSessionId === currentSessionId);
};

const createUploadControlReader = ({ uploadSessionId = "" } = {}) => {
  let cache = {
    checkedAtMs: 0,
    pauseRequested: false,
    skipRequested: false,
    uploadPaused: false,
    uploadThrottleMbps: null,
  };

  return async ({ force = false } = {}) => {
    const nowMs = Date.now();
    if (!force && nowMs - cache.checkedAtMs < 1000) return cache;

    const control = await readSoftuchiveControl(repoRoot);
    cache = {
      checkedAtMs: nowMs,
      pauseRequested: control.pauseRequested === true,
      skipRequested: isSkipRequestedForUpload(control, uploadSessionId),
      uploadPaused: control.uploadPaused === true,
      uploadThrottleMbps: normalizeUploadThrottleMbps(control.uploadThrottleMbps),
    };
    return cache;
  };
};

class DynamicUploadThrottleStream extends Transform {
  constructor({ readControl, onChunkSent } = {}) {
    super();
    this.readControl = typeof readControl === "function" ? readControl : async () => ({});
    this.onChunkSent = typeof onChunkSent === "function" ? onChunkSent : null;
    this.activeLimitMbps = null;
    this.limitStartedAtMs = Date.now();
    this.bytesSentUnderLimit = 0;
  }

  async waitForControl() {
    while (true) {
      const control = await this.readControl();
      if (control.pauseRequested) {
        throw createPipelineControlError("Pause requested during YouTube upload.", SOFTUCHIVE_PAUSE_ERROR_CODE);
      }
      if (control.skipRequested) {
        throw createPipelineControlError("Skip requested for this VOD.", SOFTUCHIVE_SKIP_ERROR_CODE);
      }
      const uploadThrottleMbps = normalizeUploadThrottleMbps(control.uploadThrottleMbps);
      if (!control.uploadPaused) {
        return {
          uploadPaused: false,
          uploadThrottleMbps,
        };
      }
      if (this.onChunkSent) {
        this.onChunkSent(0, {
          uploadPaused: true,
          uploadThrottleMbps,
          uploadMbps: 0,
        });
      }
      await waitMs(500);
    }
  }

  resetLimitWindow(limitMbps) {
    if (this.activeLimitMbps === limitMbps) return;
    this.activeLimitMbps = limitMbps;
    this.limitStartedAtMs = Date.now();
    this.bytesSentUnderLimit = 0;
  }

  async waitForThrottle(byteLength, limitMbps) {
    if (!Number.isFinite(limitMbps) || limitMbps <= 0) {
      this.resetLimitWindow(null);
      return;
    }

    this.resetLimitWindow(limitMbps);
    const bytesPerSecond = (limitMbps * 1_000_000) / 8;
    this.bytesSentUnderLimit += byteLength;
    const targetElapsedMs = (this.bytesSentUnderLimit / bytesPerSecond) * 1000;
    const elapsedMs = Date.now() - this.limitStartedAtMs;
    const waitForMs = Math.ceil(targetElapsedMs - elapsedMs);
    if (waitForMs > 0) {
      await waitMs(waitForMs);
    }
  }

  async sendChunk(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const control = await this.waitForControl();
      const limitMbps = normalizeUploadThrottleMbps(control.uploadThrottleMbps);
      const bytesPerSecond = limitMbps ? (limitMbps * 1_000_000) / 8 : chunk.length;
      const sliceSize = limitMbps ? Math.max(1024, Math.min(64 * 1024, Math.ceil(bytesPerSecond / 8))) : chunk.length - offset;
      const end = Math.min(chunk.length, offset + sliceSize);
      const slice = chunk.subarray(offset, end);

      await this.waitForThrottle(slice.length, limitMbps);
      this.push(slice);
      if (this.onChunkSent) {
        this.onChunkSent(slice.length, {
          uploadPaused: false,
          uploadThrottleMbps: limitMbps,
        });
      }
      offset = end;
    }
  }

  _transform(chunk, _encoding, callback) {
    this.sendChunk(chunk).then(() => callback(), callback);
  }
}

const normalizeYouTubeLookupText = (value) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

const getYouTubeUploadsPlaylistId = async (youtube) => {
  const response = await youtube.channels.list({
    part: ["contentDetails"],
    mine: true,
  });

  const playlistId = response.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) fail("Could not resolve YouTube uploads playlist for the authenticated channel");
  return String(playlistId);
};

const findMatchingRecentYouTubeUpload = async ({ youtube, title, description, notBeforeMs }) => {
  const uploadsPlaylistId = await getYouTubeUploadsPlaylistId(youtube);
  const response = await youtube.playlistItems.list({
    part: ["snippet", "contentDetails"],
    playlistId: uploadsPlaylistId,
    maxResults: 15,
  });

  const expectedTitle = normalizeYouTubeLookupText(title);
  const expectedDescription = normalizeYouTubeLookupText(description);
  const minimumPublishedAtMs = Number.isFinite(notBeforeMs) ? notBeforeMs : 0;

  const candidates = Array.isArray(response.data.items) ? response.data.items : [];
  for (const item of candidates) {
    const videoId = String(item?.contentDetails?.videoId || "").trim();
    if (!videoId) continue;

    const publishedAtMs = new Date(item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || 0).getTime();
    if (minimumPublishedAtMs > 0 && Number.isFinite(publishedAtMs) && publishedAtMs < minimumPublishedAtMs) continue;

    const candidateTitle = normalizeYouTubeLookupText(item?.snippet?.title);
    const candidateDescription = normalizeYouTubeLookupText(item?.snippet?.description);
    if (candidateTitle !== expectedTitle || candidateDescription !== expectedDescription) continue;
    return videoId;
  }

  return "";
};

const waitForMatchingRecentYouTubeUpload = async ({
  youtube,
  title,
  description,
  notBeforeMs,
  timeoutMs = 8 * 60 * 1000,
  pollIntervalMs = 15 * 1000,
}) => {
  const deadline = Date.now() + Math.max(5_000, Number(timeoutMs) || 0);
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const matchedVideoId = await findMatchingRecentYouTubeUpload({
        youtube,
        title,
        description,
        notBeforeMs,
      });
      if (matchedVideoId) return matchedVideoId;
      lastError = null;
    } catch (error) {
      lastError = error;
    }

    await waitMs(Math.max(1_000, Number(pollIntervalMs) || 0));
  }

  if (lastError) {
    fail(`YouTube upload lookup fallback failed: ${lastError.message}`);
  }
  return "";
};

const uploadRecordingToYouTube = async ({
  youtube,
  recordingFile,
  title,
  description,
  uploadSessionId = "",
  onProgress,
  attemptNumber = 1,
  maxAttempts = 1,
  stallTimeoutMs = SOFTUCHIVE_UPLOAD_STALL_TIMEOUT_MS,
}) => {
  log(`Uploading to YouTube: ${recordingFile.path}`);
  if (softuchiveTracker) {
    await softuchiveTracker.throwIfPauseRequested("Pause requested before YouTube upload started.");
    await softuchiveTracker.setStage(
      "uploading",
      `Uploading ${recordingFile.name} to YouTube${maxAttempts > 1 ? ` (attempt ${attemptNumber}/${maxAttempts})` : ""}.`
    );
  }
  const totalBytes = Number(recordingFile.size || 0);
  let uploadedBytes = 0;
  let lastReportedPercent = -1;
  let lastReportedAt = 0;
  let uploadReadCompletedAtMs = null;
  let lookupRecoveredUpload = false;
  let lastByteProgressAtMs = Date.now();
  let lastByteCount = 0;
  let healthCheckInFlight = false;
  let currentUploadMbps = 0;
  let lastSpeedSampleAtMs = Date.now();
  let lastSpeedSampleBytes = 0;
  let lastControlReport = {
    uploadPaused: false,
    uploadThrottleMbps: null,
  };

  const reportUploadProgress = (byteLength = 0, controlPatch = {}) => {
    const now = Date.now();
    const sentBytes = Math.max(0, Number(byteLength) || 0);
    if (sentBytes > 0) {
      uploadedBytes += sentBytes;
      if (uploadedBytes > lastByteCount) {
        lastByteCount = uploadedBytes;
        lastByteProgressAtMs = now;
      }
      if (uploadedBytes >= totalBytes && !uploadReadCompletedAtMs) {
        uploadReadCompletedAtMs = now;
      }

      const speedElapsedMs = Math.max(1, now - lastSpeedSampleAtMs);
      if (speedElapsedMs >= 500) {
        currentUploadMbps = Math.max(0, ((uploadedBytes - lastSpeedSampleBytes) * 8) / (speedElapsedMs * 1000));
        lastSpeedSampleAtMs = now;
        lastSpeedSampleBytes = uploadedBytes;
      }
    } else if (Number.isFinite(Number(controlPatch.uploadMbps))) {
      currentUploadMbps = Math.max(0, Number(controlPatch.uploadMbps));
    }

    lastControlReport = {
      uploadPaused:
        Object.prototype.hasOwnProperty.call(controlPatch, "uploadPaused")
          ? controlPatch.uploadPaused === true
          : lastControlReport.uploadPaused,
      uploadThrottleMbps:
        Object.prototype.hasOwnProperty.call(controlPatch, "uploadThrottleMbps")
          ? normalizeUploadThrottleMbps(controlPatch.uploadThrottleMbps)
          : lastControlReport.uploadThrottleMbps,
    };

    if (typeof onProgress !== "function" || totalBytes <= 0) return;

    const percent = Math.max(0, Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)));
    const controlChanged =
      lastControlReport.uploadPaused === true ||
      normalizeUploadThrottleMbps(controlPatch.uploadThrottleMbps) !== null ||
      Object.prototype.hasOwnProperty.call(controlPatch, "uploadThrottleMbps");
    if (sentBytes > 0) {
      if (percent === lastReportedPercent && now - lastReportedAt < 800) return;
      if (percent < 100 && lastReportedPercent >= 0 && percent < lastReportedPercent) return;
    } else if (!controlChanged || now - lastReportedAt < 1000) {
      return;
    }

    lastReportedPercent = percent;
    lastReportedAt = now;
    onProgress({
      uploadedBytes,
      totalBytes,
      percent,
      uploadMbps: currentUploadMbps,
      uploadPaused: lastControlReport.uploadPaused,
      uploadThrottleMbps: lastControlReport.uploadThrottleMbps,
    });
  };

  const readUploadControl = createUploadControlReader({ uploadSessionId });
  const sourceStream = fsSync.createReadStream(recordingFile.path);
  const mediaBody = new DynamicUploadThrottleStream({
    readControl: readUploadControl,
    onChunkSent: reportUploadProgress,
  });
  sourceStream.on("error", (error) => mediaBody.destroy(error));
  sourceStream.pipe(mediaBody);
  const abortActiveUpload = (error) => {
    if (mediaBody.destroyed) return;
    try {
      mediaBody.destroy(error);
    } catch {}
    try {
      sourceStream.destroy(error);
    } catch {}
  };

  const uploadStartedAtMs = Date.now();
  let insertSettled = false;
  const uploadHealthTimer = setInterval(() => {
    if (insertSettled || healthCheckInFlight) return;
    healthCheckInFlight = true;
    void (async () => {
      try {
        const control = await readUploadControl({ force: true });
        if (control.skipRequested) {
          abortActiveUpload(createPipelineControlError("Skip requested for this VOD.", SOFTUCHIVE_SKIP_ERROR_CODE));
          return;
        }

        if (control.pauseRequested || (softuchiveTracker && (await softuchiveTracker.shouldPause()))) {
          abortActiveUpload(createPipelineControlError("Pause requested during YouTube upload.", SOFTUCHIVE_PAUSE_ERROR_CODE));
          return;
        }

        if (uploadReadCompletedAtMs) return;

        const nowMs = Date.now();
        if (nowMs - lastByteProgressAtMs >= Math.max(15_000, stallTimeoutMs)) {
          abortActiveUpload(
            createPipelineControlError(
              `Upload stalled for ${Math.ceil((nowMs - lastByteProgressAtMs) / 1000)} seconds.`,
              SOFTUCHIVE_UPLOAD_STALL_ERROR_CODE
            )
          );
        }
      } finally {
        healthCheckInFlight = false;
      }
    })();
  }, 2000);
  if (typeof uploadHealthTimer?.unref === "function") uploadHealthTimer.unref();

  const insertPromise = youtube.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: true,
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: config.youtubeCategoryId,
      },
      status: {
        privacyStatus: "private",
      },
    },
    media: {
      body: mediaBody,
    },
  });
  const trackedInsertPromise = insertPromise.then(
    (response) => {
      insertSettled = true;
      return {
        kind: "insert",
        response,
      };
    },
    (error) => {
      insertSettled = true;
      throw error;
    }
  );
  void trackedInsertPromise.catch((error) => {
    if (lookupRecoveredUpload) {
      log(`YouTube insert call rejected after fallback recovery: ${error.message}`);
    }
    return null;
  });

  const lookupFallbackPromise = (async () => {
    while (!uploadReadCompletedAtMs) {
      if (insertSettled) return null;
      await waitMs(1_000);
    }

    await waitMs(60_000);
    if (insertSettled) return null;

    const matchedVideoId = await waitForMatchingRecentYouTubeUpload({
      youtube,
      title,
      description,
      notBeforeMs: uploadStartedAtMs - 5 * 60 * 1000,
    });
    if (!matchedVideoId) {
      fail("YouTube upload bytes finished sending, but no matching uploaded video was found.");
    }

    log(`Recovered YouTube upload from recent channel uploads: ${matchedVideoId}`);
    lookupRecoveredUpload = true;
    return {
      kind: "lookup",
      response: {
        data: {
          id: matchedVideoId,
        },
      },
    };
  })().catch((error) => {
    if (insertSettled) return null;
    throw error;
  });

  let settledUpload = null;
  try {
    settledUpload = await Promise.race([trackedInsertPromise, lookupFallbackPromise]);
  } finally {
    clearInterval(uploadHealthTimer);
  }
  const response = settledUpload?.response;
  if (!response) {
    const directResponse = await trackedInsertPromise;
    return String(directResponse.response.data.id || "");
  }

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
  if (!item?.snippet) return false;

  const snippet = item.snippet;
  const nextCategoryId = String(config.youtubeCategoryId || "");
  if (
    String(snippet.title || "") === String(title || "") &&
    String(snippet.description || "") === String(description || "") &&
    String(snippet.categoryId || "") === nextCategoryId
  ) {
    return false;
  }

  await youtube.videos.update({
    part: ["snippet"],
    requestBody: {
      id: videoId,
      snippet: {
        ...snippet,
        title,
        description,
        categoryId: nextCategoryId,
      },
    },
  });
  return true;
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

    const changed = await updateYouTubeVideoMetadata(youtube, part.id, { title, description });
    if (changed) {
      log(`Updated YouTube metadata for VOD ${twitchVodId} part ${part.part || 1}: ${part.id}`);
    }
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

const commitArchiveDataLocally = (gitPaths, commitMessage) => {
  runGitCommand(["add", "--", ...gitPaths], { cwd: repoRoot });

  const checkDiff = runGitCommand(["diff", "--cached", "--quiet", "--", ...gitPaths], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (checkDiff.status === 0) {
    log("No archive data changes to commit locally.");
    return false;
  }
  if (checkDiff.status !== 1) {
    const details = [checkDiff.stdout, checkDiff.stderr].filter(Boolean).join("\n");
    fail(`git diff --cached failed${details ? `: ${details}` : ""}`);
  }

  runGitCommand([...gitCommitIdentityArgs(), "commit", "-m", commitMessage], { cwd: repoRoot });
  return true;
};

const syncArchiveFilesToPublishWorktree = async (entries, worktreeDir) => {
  for (const { sourcePath, gitPath } of entries) {
    const destinationPath = path.join(worktreeDir, ...gitPath.split("/"));
    if (await fileExists(sourcePath)) {
      await ensureDirectory(path.dirname(destinationPath));
      await fs.copyFile(sourcePath, destinationPath);
      continue;
    }

    await fs.rm(destinationPath, { recursive: true, force: true });
  }
};

const publishArchiveDataToOrigin = async (entries, gitPaths, commitMessage) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "soft-site-archive-publish-"));
    let worktreeAdded = false;

    try {
      runGitCommand(["fetch", "origin", "main"], { cwd: repoRoot });
      runGitCommand(["worktree", "add", "--detach", worktreeDir, "origin/main"], { cwd: repoRoot });
      worktreeAdded = true;

      await syncArchiveFilesToPublishWorktree(entries, worktreeDir);
      runGitCommand(["add", "--all", "--", ...gitPaths], { cwd: worktreeDir });

      const checkDiff = runGitCommand(["diff", "--cached", "--quiet", "--", ...gitPaths], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      if (checkDiff.status === 0) {
        log("No archive data changes needed on origin/main.");
        return false;
      }
      if (checkDiff.status !== 1) {
        const details = [checkDiff.stdout, checkDiff.stderr].filter(Boolean).join("\n");
        fail(`git diff --cached failed in publish worktree${details ? `: ${details}` : ""}`);
      }

      runGitCommand([...gitCommitIdentityArgs(), "commit", "-m", commitMessage], { cwd: worktreeDir });

      const push = runGitCommand(["push", "origin", "HEAD:main"], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      if (push.status === 0) {
        log("Published archive data to origin/main using an isolated worktree.");
        return true;
      }

      const pushOutput = [push.stdout, push.stderr].filter(Boolean).join("\n");
      const needsRetry =
        attempt < 2 && /(fetch first|non-fast-forward|failed to push some refs)/i.test(pushOutput || "");
      if (!needsRetry) {
        fail(`git push failed${pushOutput ? `: ${pushOutput}` : ""}`);
      }

      log("origin/main moved during archive publish. Refetching and retrying once.");
    } finally {
      if (worktreeAdded) {
        runGitCommand(["worktree", "remove", "--force", worktreeDir], {
          cwd: repoRoot,
          allowFailure: true,
        });
      }
      await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return false;
};

const stageAndPushArchiveData = async (filePaths, commitMessage) => {
  const entries = Array.from(
    new Map(
      filePaths
        .map((filePath) => path.resolve(filePath))
        .map((sourcePath) => [sourcePath, { sourcePath, gitPath: toGitRepoPath(sourcePath) }])
    ).values()
  ).filter((entry) => !entry.gitPath.startsWith(".."));

  const gitPaths = entries.map((entry) => entry.gitPath);
  if (gitPaths.length === 0) {
    log("No archive data paths were eligible for git publishing.");
    return;
  }

  commitArchiveDataLocally(gitPaths, commitMessage);
  await publishArchiveDataToOrigin(entries, gitPaths, commitMessage);
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

const fullPipelineRequiredConfig = [
  ["TWITCH_CLIENT_ID", config.twitchClientId],
  ["TWITCH_CLIENT_SECRET", config.twitchClientSecret],
  ["TWITCH_CHANNEL_LOGIN", config.twitchChannelLogin],
  ["LOCAL_RECORDINGS_DIR", config.recordingsDir],
  ["YOUTUBE_CLIENT_SECRET_PATH", config.youtubeClientSecretPath],
];

const metadataSyncRequiredConfig = [["YOUTUBE_CLIENT_SECRET_PATH", config.youtubeClientSecretPath]];

const validateConfiguration = async ({ metadataOnly = false } = {}) => {
  const requiredConfig = metadataOnly ? metadataSyncRequiredConfig : fullPipelineRequiredConfig;
  const missing = requiredConfig.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) fail(`Missing required configuration: ${missing.join(", ")}`);

  if (!metadataOnly) {
    try {
      await ensureDirectory(config.recordingsDir);
    } catch (error) {
      fail(`Recording directory is not available: ${config.recordingsDir} (${error.message})`);
    }
  }

  if (!metadataOnly && !(await fileExists(config.recordingsDir))) {
    fail(`Recording directory does not exist after setup: ${config.recordingsDir}`);
  }
};

const softuchivePaths = resolveSoftuchivePaths(repoRoot);

const cloneJson = (value) => {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
};

const createPipelineControlError = (message, code) => Object.assign(new Error(message), { code });
const isSoftuchivePauseError = (error) => error?.code === SOFTUCHIVE_PAUSE_ERROR_CODE;
const isSoftuchiveSkipError = (error) => error?.code === SOFTUCHIVE_SKIP_ERROR_CODE;
const isSoftuchiveUploadStallError = (error) => error?.code === SOFTUCHIVE_UPLOAD_STALL_ERROR_CODE;

const loadSoftuchiveSettingsIntoConfig = async () => {
  const { settings } = await ensureSoftuchiveStateFiles(repoRoot, { archiveFolder: config.recordingsDir });
  if (settings?.archiveFolder) {
    config.recordingsDir = settings.archiveFolder;
  }
  return settings;
};

const buildSoftuchiveSummaryLines = (summary = {}) => {
  const lines = [
    "=== Softuchive Archive Summary ===",
    `Run ID: ${summary.runId || "unknown"}`,
    `Trigger: ${summary.trigger || "unknown"}`,
    `Status: ${summary.status || "unknown"}`,
    `Started: ${summary.startedAt || "unknown"}`,
    `Completed: ${summary.completedAt || "unknown"}`,
    `Archive Folder: ${summary.archiveFolder || config.recordingsDir}`,
    `Queued Uploads: ${Number(summary.queuedUploads || 0)}`,
    `Archived Parts: ${Number(summary.archivedPartCount || 0)}`,
    `Backfilled Chats: ${Number(summary.backfilledChatCount || 0)}`,
    `Backfilled Emotes: ${Number(summary.backfilledEmoteCount || 0)}`,
  ];

  if (summary.error) {
    lines.push(`Error: ${summary.error}`);
  }

  const archivedParts = Array.isArray(summary.archivedParts) ? summary.archivedParts : [];
  if (archivedParts.length > 0) {
    lines.push("Archived Parts:");
    for (const part of archivedParts) {
      const durationLabel =
        Number.isFinite(Number(part?.durationSeconds)) && Number(part.durationSeconds) > 0
          ? ` (${formatDuration(Math.floor(Number(part.durationSeconds)))})`
          : "";
      lines.push(
        `- Twitch ${part?.twitchVodId || "?"} Part ${part?.partNumber || "?"} -> ${part?.youtubeVideoId || "pending"}${durationLabel}`
      );
    }
  }

  const skippedRecordings = Array.isArray(summary.skippedRecordings) ? summary.skippedRecordings : [];
  if (skippedRecordings.length > 0) {
    lines.push("Skipped Recordings:");
    for (const item of skippedRecordings) {
      lines.push(`- ${item?.recordingName || "unknown"}: ${item?.reason || "skipped"}`);
    }
  }

  const notes = Array.isArray(summary.notes) ? summary.notes : [];
  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines;
};

const createSoftuchiveTracker = async ({ trigger = "manual", metadataOnly = false } = {}) => {
  const settings = await loadSoftuchiveSettingsIntoConfig();
  const stateFiles = await ensureSoftuchiveStateFiles(repoRoot, { archiveFolder: config.recordingsDir });
  let runtime = await readSoftuchiveRuntime(repoRoot, { archiveFolder: config.recordingsDir });
  let events = Array.isArray(runtime.events) ? runtime.events.slice(-120) : [];
  let pauseCache = {
    checkedAtMs: 0,
    requested: false,
  };
  const startedAt = new Date().toISOString();
  const runId = `softuchive-${Date.now()}`;
  const summary = {
    runId,
    trigger,
    status: "running",
    startedAt,
    completedAt: null,
    archiveFolder: config.recordingsDir,
    queuedUploads: 0,
    archivedPartCount: 0,
    archivedParts: [],
    backfilledChatCount: 0,
    backfilledEmoteCount: 0,
    skippedRecordings: [],
    notes: [],
    error: "",
  };

  const persist = async () => {
    runtime.events = events.slice(-120);
    runtime.app = {
      ...(runtime.app || {}),
      archiveFolder: config.recordingsDir,
      taskLogPath: softuchivePaths.taskLogPath,
      summaryLogPath: softuchivePaths.summaryLogPath,
    };
    runtime.updatedAt = new Date().toISOString();
    runtime = await writeSoftuchiveRuntime(repoRoot, runtime, { archiveFolder: config.recordingsDir });
    return runtime;
  };

  const pushEvent = async ({ timestamp, message }) => {
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) return;
    events.push({
      timestamp: timestamp || new Date().toISOString(),
      message: normalizedMessage,
    });
    if (events.length > 120) {
      events = events.slice(-120);
    }
    await persist();
  };

  const setRunState = async (nextRun) => {
    runtime.run = {
      ...(runtime.run || {}),
      ...cloneJson(nextRun),
    };
    await persist();
  };

  const shouldPause = async ({ force = false } = {}) => {
    const nowMs = Date.now();
    if (!force && nowMs - pauseCache.checkedAtMs < 1000) {
      return pauseCache.requested;
    }
    const control = await readSoftuchiveControl(repoRoot);
    pauseCache = {
      checkedAtMs: nowMs,
      requested: control.pauseRequested === true,
    };
    return pauseCache.requested;
  };

  const throwIfPauseRequested = async (message = "Pause requested. Stopping archive run.") => {
    if (await shouldPause({ force: true })) {
      throw createPipelineControlError(message, SOFTUCHIVE_PAUSE_ERROR_CODE);
    }
  };

  const updateQueueFromUploads = async (plannedUploads = []) => {
    const items = Array.isArray(plannedUploads) ? plannedUploads : [];
    const totalBytes = items.reduce((sum, item) => sum + Math.max(0, Number(item?.recording?.size || 0)), 0);
    summary.queuedUploads = items.length;
    runtime.run = {
      ...(runtime.run || {}),
      queue: {
        ...(runtime.run?.queue || {}),
        total: items.length,
        remaining: items.length,
        totalBytes,
        remainingBytes: totalBytes,
      },
      uploads: items.map((item, index) => ({
        sessionId: `${runId}-queued-${index + 1}`,
        state: "queued",
        twitchVodId: String(item?.twitchVod?.id || ""),
        partNumber: null,
        title: String(item?.twitchVod?.title || item?.recording?.name || ""),
        recordingName: String(item?.recording?.name || ""),
        streamDate: String(item?.twitchVod?.created_at || ""),
        message: "Queued for archive",
        percent: 0,
        uploadedBytes: 0,
        totalBytes: Number(item?.recording?.size || 0) || null,
        youtubeVideoId: null,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        stallAttempt: 0,
      })),
    };
    await persist();
  };

  const updateActiveUpload = async (patch) => {
    const queueUploads = Array.isArray(runtime.run?.uploads) ? [...runtime.run.uploads] : [];
    const sessionId = String(patch?.sessionId || "").trim();
    if (!sessionId) return;

    const existingIndex = queueUploads.findIndex((entry) => String(entry?.sessionId || "") === sessionId);
    const nextUpload = {
      ...(existingIndex >= 0 ? queueUploads[existingIndex] : {}),
      ...cloneJson(patch),
      updatedAtMs: Date.now(),
    };
    if (existingIndex >= 0) queueUploads[existingIndex] = nextUpload;
    else queueUploads.push(nextUpload);

    const activeUploads = queueUploads.filter((entry) => !["done", "error", "paused", "skipped"].includes(String(entry?.state || "")));
    const remainingBytes = activeUploads.reduce((sum, entry) => {
      const totalBytes = Number(entry?.totalBytes || 0);
      const uploadedBytes = Number(entry?.uploadedBytes || 0);
      return sum + Math.max(0, totalBytes - uploadedBytes);
    }, 0);

    runtime.run = {
      ...(runtime.run || {}),
      uploads: queueUploads,
      current: {
        ...(runtime.run?.current || {}),
        ...cloneJson(patch),
      },
      queue: {
        ...(runtime.run?.queue || {}),
        remaining: activeUploads.length,
        remainingBytes,
        estimatedRemainingMs:
          activeUploads.length === 0
            ? null
            : Number.isFinite(Number(patch?.estimatedRemainingMs)) && Number(patch.estimatedRemainingMs) > 0
              ? Math.floor(Number(patch.estimatedRemainingMs))
              : runtime.run?.queue?.estimatedRemainingMs || null,
      },
    };
    await persist();
  };

  const noteArchivedPart = async (item) => {
    summary.archivedPartCount += 1;
    summary.archivedParts.push(cloneJson(item));
    await persist();
  };

  const noteSkippedRecording = async (recordingName, reason) => {
    summary.skippedRecordings.push({
      recordingName,
      reason,
    });
    await persist();
  };

  const noteBackfilledChat = async (vodId, commentsCount, emotesCount) => {
    summary.backfilledChatCount += 1;
    summary.notes.push(`Backfilled chat for Twitch VOD ${vodId} (${commentsCount} comments, ${emotesCount} embedded emotes).`);
    await persist();
  };

  const noteBackfilledEmotes = async (vodId) => {
    summary.backfilledEmoteCount += 1;
    summary.notes.push(`Backfilled emotes for Twitch VOD ${vodId}.`);
    await persist();
  };

  const start = async () => {
    runtime = {
      ...runtime,
      app: {
        ...(runtime.app || {}),
        archiveFolder: config.recordingsDir,
        taskLogPath: stateFiles.paths.taskLogPath,
        summaryLogPath: stateFiles.paths.summaryLogPath,
      },
      run: {
        ...(runtime.run || {}),
        active: true,
        status: "running",
        trigger,
        stage: metadataOnly ? "metadata-sync" : "starting",
        message: metadataOnly ? "Starting metadata sync." : "Starting archive poll.",
        startedAt,
        completedAt: null,
        lastPollStartedAt: startedAt,
        summary: null,
        error: null,
        current: null,
        queue: {
          total: 0,
          remaining: 0,
          totalBytes: 0,
          remainingBytes: 0,
          estimatedRemainingMs: null,
        },
        uploads: [],
      },
    };
    softuchiveLogSink = pushEvent;
    await persist();
  };

  const setStage = async (stage, message, extraRun = {}) => {
    runtime.run = {
      ...(runtime.run || {}),
      ...cloneJson(extraRun),
      stage,
      message,
    };
    await persist();
  };

  const finish = async ({ status, message, error = null } = {}) => {
    const completedAt = new Date().toISOString();
    summary.status = status || "completed";
    summary.completedAt = completedAt;
    summary.error = error ? String(error?.message || error) : summary.error;
    runtime.run = {
      ...(runtime.run || {}),
      active: false,
      status: summary.status,
      stage: summary.status === "error" ? "error" : summary.status === "paused" ? "paused" : "idle",
      message: message || (summary.status === "completed" ? "Archive poll complete." : "Archive poll ended."),
      completedAt,
      lastPollCompletedAt: completedAt,
      lastPollStatus: summary.status,
      summary: cloneJson(summary),
      error: summary.error || null,
    };
    await persist();
    await appendSoftuchiveSummary(repoRoot, buildSoftuchiveSummaryLines(summary));
    softuchiveLogSink = null;
  };

  return {
    paths: stateFiles.paths,
    settings,
    start,
    setStage,
    setRunState,
    shouldPause,
    throwIfPauseRequested,
    updateQueueFromUploads,
    updateActiveUpload,
    noteArchivedPart,
    noteSkippedRecording,
    noteBackfilledChat,
    noteBackfilledEmotes,
    finish,
  };
};

const getVodsNeedingMetadataSync = (existingVods = [], state = {}) =>
  existingVods.filter((vod) => {
    const youtubeParts = Array.isArray(vod?.youtube) ? vod.youtube.filter((part) => part?.id) : [];
    if (youtubeParts.length === 0) return false;
    const metadataVersion = Number(state.processedVodIds?.[String(vod.id)]?.metadataVersion || 0);
    return metadataVersion < METADATA_TEMPLATE_VERSION;
  });

const runYouTubeVisibilitySyncOnly = async () => {
  softuchiveTracker = await createSoftuchiveTracker({ trigger: pipelineTrigger, metadataOnly: true });
  await softuchiveTracker.start();
  await softuchiveTracker.throwIfPauseRequested("Pause requested before YouTube visibility sync started.");
  await softuchiveTracker.setStage("youtube-visibility", "Checking YouTube publish status for archived VODs.");
  await validateConfiguration({ metadataOnly: true });
  await ensureDirectory(path.dirname(config.vodsDataPath));

  const existingVods = await readJsonFile(config.vodsDataPath, []);
  const videoIds = collectArchiveYouTubeVideoIds(existingVods);
  if (videoIds.length === 0) {
    log("No archived YouTube VOD parts require visibility sync.");
    await softuchiveTracker.finish({
      status: "completed",
      message: "No archived YouTube VOD parts require visibility sync.",
    });
    return;
  }

  const youtube = await loadYoutubeClient();
  const syncResult = await syncArchiveYouTubeVisibility(youtube, existingVods);

  if (!syncResult.changed) {
    log(`YouTube visibility sync checked ${syncResult.checkedVideoCount} video(s); no archive changes were needed.`);
    await softuchiveTracker.finish({
      status: "completed",
      message: `YouTube visibility sync checked ${syncResult.checkedVideoCount} video(s); no archive changes were needed.`,
    });
    return;
  }

  if (config.dryRun) {
    log(`[DRY RUN] YouTube visibility sync would hide ${syncResult.hiddenVodIds.length} and restore ${syncResult.restoredVodIds.length} VOD(s).`);
    await softuchiveTracker.finish({
      status: "completed",
      message: `[DRY RUN] YouTube visibility sync would update ${syncResult.hiddenVodIds.length + syncResult.restoredVodIds.length} VOD(s).`,
    });
    return;
  }

  await writeJsonFile(config.vodsDataPath, existingVods);

  if (config.autoGitPush) {
    await stageAndPushArchiveData([config.vodsDataPath], "chore: sync youtube vod visibility");
  }

  log(
    `YouTube visibility sync updated archive data. Hidden VODs: ${syncResult.hiddenVodIds.length}; restored VODs: ${syncResult.restoredVodIds.length}; hidden parts: ${syncResult.hiddenPartIds.length}; restored parts: ${syncResult.restoredPartIds.length}.`
  );
  await softuchiveTracker.finish({
    status: "completed",
    message: `YouTube visibility sync updated archive data. Hidden ${syncResult.hiddenVodIds.length}, restored ${syncResult.restoredVodIds.length}.`,
  });
};

const runMetadataSyncOnly = async () => {
  softuchiveTracker = await createSoftuchiveTracker({ trigger: pipelineTrigger, metadataOnly: true });
  await softuchiveTracker.start();
  await softuchiveTracker.throwIfPauseRequested("Pause requested before metadata sync started.");
  await softuchiveTracker.setStage("metadata-sync", "Loading YouTube metadata sync queue.");
  await validateConfiguration({ metadataOnly: true });
  await ensureDirectory(path.dirname(config.vodsDataPath));
  await ensureDirectory(path.dirname(config.statePath));

  const state = await readJsonFile(config.statePath, {
    processedFiles: {},
    processedVodIds: {},
  });
  if (!state.processedFiles || typeof state.processedFiles !== "object") state.processedFiles = {};
  if (!state.processedVodIds || typeof state.processedVodIds !== "object") state.processedVodIds = {};

  const existingVods = await readJsonFile(config.vodsDataPath, []);
  const vodsNeedingMetadataSync = getVodsNeedingMetadataSync(existingVods, state);
  if (vodsNeedingMetadataSync.length === 0) {
    log("No existing YouTube VOD metadata requires syncing.");
    await softuchiveTracker.finish({
      status: "completed",
      message: "No YouTube metadata sync work was needed.",
    });
    return;
  }

  if (config.dryRun) {
    log(`[DRY RUN] Would sync YouTube metadata for ${vodsNeedingMetadataSync.length} VOD(s).`);
    await softuchiveTracker.finish({
      status: "completed",
      message: `[DRY RUN] Metadata sync would update ${vodsNeedingMetadataSync.length} VOD(s).`,
    });
    return;
  }

  const youtube = await loadYoutubeClient();
  await ensureYouTubeCategoryExists(youtube);

  for (const vod of vodsNeedingMetadataSync) {
    await syncYouTubeMetadataForVod(youtube, vod);

    const vodId = String(vod.id);
    const existingState = state.processedVodIds?.[vodId] || {};
    state.processedVodIds[vodId] = {
      ...existingState,
      metadataVersion: METADATA_TEMPLATE_VERSION,
      metadataSyncedAt: new Date().toISOString(),
    };
    await softuchiveTracker.setStage("metadata-sync", `Synced metadata template for Twitch VOD ${vodId}.`);
    log(`Synced YouTube metadata template for VOD ${vodId}`);
  }

  await writeJsonFile(config.statePath, state);
  await softuchiveTracker.finish({
    status: "completed",
    message: `Metadata sync complete for ${vodsNeedingMetadataSync.length} VOD(s).`,
  });
};

const runPipeline = async () => {
  softuchiveTracker = await createSoftuchiveTracker({ trigger: pipelineTrigger, metadataOnly: false });
  await softuchiveTracker.start();
  await softuchiveTracker.throwIfPauseRequested("Pause requested before archive poll started.");
  await softuchiveTracker.setStage("starting", "Validating archive pipeline configuration.");
  await validateConfiguration();
  await softuchiveTracker.setStage("preparing", "Preparing archive folders and runtime state.");
  await ensureDirectory(path.dirname(config.vodsDataPath));
  await ensureDirectory(config.commentsDir);
  await ensureDirectory(config.emotesDir);
  await ensureDirectory(path.dirname(config.badgesPath));
  await ensureDirectory(path.dirname(config.statePath));
  await ensureDirectory(config.tmpDir);
  await cleanupStaleTrack1UploadCopies();
  await softuchiveTracker.throwIfPauseRequested("Pause requested while preparing archive poll.");

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
  let youtube = null;
  const getPipelineYouTube = async () => {
    if (!youtube) {
      youtube = await loadYoutubeClient();
    }
    return youtube;
  };

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
    const ownerPid = Number(entry?.ownerPid || 0);
    const hasOwnerPid = Number.isInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid;
    const ownerAlive = hasOwnerPid && isCurrentProcessRunning(ownerPid);
    if (ownerAlive) continue;

    const isStale = hasOwnerPid || !updatedAtMs || now - updatedAtMs > PROCESSING_RECORD_STALE_AFTER_MS;
    if (!isStale) continue;

    const staleUploadSessionId = String(entry?.uploadSessionId || "").trim();
    if (staleUploadSessionId) {
      await postRealtimeUploadStatus({
        sessionId: staleUploadSessionId,
        twitchVodId: entry?.twitchVodId ? String(entry.twitchVodId) : null,
        partNumber: Number.isFinite(Number(entry?.part)) ? Math.max(1, Math.floor(Number(entry.part))) : null,
        title: entry?.title ? String(entry.title) : null,
        recordingName: entry?.recordingName ? String(entry.recordingName) : path.basename(filePath),
        streamDate: entry?.streamDate ? String(entry.streamDate) : null,
        createdAtMs:
          Number.isFinite(Number(entry?.uploadSessionCreatedAtMs)) && Number(entry.uploadSessionCreatedAtMs) > 0
            ? Math.floor(Number(entry.uploadSessionCreatedAtMs))
            : now,
        updatedAtMs: now,
        state: "error",
        message: "Recovered from an orphaned local upload session.",
        percent: Number.isFinite(Number(entry?.percent)) ? Math.max(0, Math.min(100, Math.floor(Number(entry.percent)))) : null,
        uploadedBytes: Number.isFinite(Number(entry?.uploadedBytes)) ? Math.max(0, Math.floor(Number(entry.uploadedBytes))) : null,
        totalBytes: Number.isFinite(Number(entry?.totalBytes)) ? Math.max(0, Math.floor(Number(entry.totalBytes))) : null,
        youtubeVideoId: entry?.youtubeVideoId ? String(entry.youtubeVideoId) : null,
      });
    }

    delete state.processedFiles[filePath];
    staleProcessingEntriesCleared += 1;
    log(`Cleared orphaned in-progress upload marker for ${path.basename(filePath)}`);
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

  const missingCommentVodIds = [];
  const missingEmoteVodIds = [];
  const missingBadges = !(await fileExists(config.badgesPath));
  for (const vod of existingVods) {
    const activeArchiveVod = vod?.unpublished !== true;
    const youtubeParts = Array.isArray(vod?.youtube)
      ? vod.youtube.filter((part) => part?.id && part?.unpublished !== true)
      : [];
    const previousVodState = state.processedVodIds?.[String(vod?.id)] || {};
    const lastChatBackfillFailureMs = parseTimestampMs(previousVodState.commentsBackfillLastFailedAt);
    const chatBackfillRetryDue =
      !lastChatBackfillFailureMs || now - lastChatBackfillFailureMs >= CHAT_BACKFILL_RETRY_INTERVAL_MS;
    if (activeArchiveVod && vod?.chatReplayAvailable !== false && youtubeParts.length > 0 && chatBackfillRetryDue) {
      const commentsPath = path.join(config.commentsDir, `${vod.id}.json`);
      if (!(await fileExists(commentsPath))) missingCommentVodIds.push(String(vod.id));
    }
    const emotePath = path.join(config.emotesDir, `${vod.id}.json`);
    if (activeArchiveVod && !(await fileExists(emotePath))) missingEmoteVodIds.push(String(vod.id));
  }

  const vodsNeedingMetadataSync = getVodsNeedingMetadataSync(existingVods, state);

  await softuchiveTracker.setStage("scanning", "Scanning recording queue and archive maintenance needs.");

  const visibilitySyncState =
    state.youtubeVisibilitySync && typeof state.youtubeVisibilitySync === "object" ? state.youtubeVisibilitySync : {};
  const lastVisibilitySyncAtMs = parseTimestampMs(visibilitySyncState.checkedAt);
  const visibilitySyncDue =
    !lastVisibilitySyncAtMs || now - lastVisibilitySyncAtMs >= YOUTUBE_VISIBILITY_SYNC_INTERVAL_MS;

  if (
    !config.dryRun &&
    config.youtubeVisibilitySyncEnabled &&
    visibilitySyncDue &&
    collectArchiveYouTubeVideoIds(existingVods).length > 0
  ) {
    await softuchiveTracker.setStage("youtube-visibility", "Checking YouTube publish status for archived VODs.");
    const syncResult = await syncArchiveYouTubeVisibility(await getPipelineYouTube(), existingVods);
    state.youtubeVisibilitySync = {
      checkedAt: new Date().toISOString(),
      intervalMinutes: Math.round(YOUTUBE_VISIBILITY_SYNC_INTERVAL_MS / 60000),
      checkedVideoCount: syncResult.checkedVideoCount,
      changed: syncResult.changed,
      hiddenVodCount: syncResult.hiddenVodIds.length,
      restoredVodCount: syncResult.restoredVodIds.length,
      hiddenPartCount: syncResult.hiddenPartIds.length,
      restoredPartCount: syncResult.restoredPartIds.length,
    };
    await persistState();

    if (syncResult.changed) {
      vodsUpdated = true;
      log(
        `YouTube visibility sync updated archive data. Hidden VODs: ${syncResult.hiddenVodIds.length}; restored VODs: ${syncResult.restoredVodIds.length}; hidden parts: ${syncResult.hiddenPartIds.length}; restored parts: ${syncResult.restoredPartIds.length}.`
      );
    } else {
      log(`YouTube visibility sync checked ${syncResult.checkedVideoCount} video(s); no archive changes were needed.`);
    }
  } else if (!config.dryRun && config.youtubeVisibilitySyncEnabled && !visibilitySyncDue) {
    log(
      `YouTube visibility sync skipped; last checked ${visibilitySyncState.checkedAt}, next check after ${Math.round(
        YOUTUBE_VISIBILITY_SYNC_INTERVAL_MS / 60000
      )} minutes.`
    );
  }

  if (
    recordings.length === 0 &&
    missingCommentVodIds.length === 0 &&
    missingEmoteVodIds.length === 0 &&
    !missingBadges &&
    vodsNeedingMetadataSync.length === 0 &&
    !vodsUpdated
  ) {
    log("No completed recordings ready for processing.");
    await softuchiveTracker.finish({
      status: "completed",
      message: "No completed recordings or archive maintenance work were ready.",
    });
    return;
  }

  if (
    recordings.length === 0 &&
    missingCommentVodIds.length === 0 &&
    missingEmoteVodIds.length === 0 &&
    !missingBadges &&
    vodsNeedingMetadataSync.length === 0 &&
    vodsUpdated
  ) {
    if (config.dryRun) {
      log("[DRY RUN] Archive maintenance detected but no files were written.");
      await softuchiveTracker.finish({
        status: "completed",
        message: "[DRY RUN] Archive maintenance was detected, but no files were written.",
      });
      return;
    }

    await writeJsonFile(config.vodsDataPath, existingVods);
    stagedPaths.push(config.vodsDataPath);
    await writeJsonFile(config.statePath, state);

    if (config.autoGitPush && stagedPaths.length > 0) {
      await stageAndPushArchiveData(stagedPaths, "chore: maintain archive vod data");
    }

    log("Applied archive maintenance updates.");
    await softuchiveTracker.finish({
      status: "completed",
      message: "Archive maintenance updates were applied.",
    });
    return;
  }

  const twitchAccessToken = await fetchTwitchAppAccessToken();
  await softuchiveTracker.throwIfPauseRequested("Pause requested before Twitch lookup started.");
  await softuchiveTracker.setStage("polling", "Polling Twitch archives and archive dependencies.");
  const twitchUser = await fetchTwitchUser(twitchAccessToken);
  const shouldSyncBadges = missingBadges || recordings.length > 0 || missingCommentVodIds.length > 0;
  if (shouldSyncBadges) {
    await softuchiveTracker.setStage("badges", "Refreshing static chat badges.");
    await syncStaticBadges(twitchAccessToken, twitchUser, stagedPaths);
  }
  const twitchVods = recordings.length > 0 ? await fetchTwitchArchives(twitchAccessToken, twitchUser.id) : [];
  const channelEmoteSets = await fetchThirdPartyEmoteSets(twitchUser.id);

  if (recordings.length > 0 && twitchVods.length === 0) {
    log("No Twitch archives found yet.");
  }

  const maxRecordingsPerRun = Math.max(1, config.maxRecordingsPerRun);
  const latestTwitchVod =
    config.onlyUploadMostRecentVod && twitchVods.length > 0
      ? twitchVods
          .slice()
          .sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime())[0]
      : null;
  const targetTwitchVods = latestTwitchVod ? [latestTwitchVod] : twitchVods;
  const targets = config.onlyUploadMostRecentVod
    ? recordings.slice().sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    : recordings.slice(0, maxRecordingsPerRun);

  if (latestTwitchVod) {
    log(`Only-upload-most-recent mode enabled; matching recordings against latest Twitch VOD ${latestTwitchVod.id}.`);
  }

  const plannedUploads = [];
  for (const recording of targets) {
    if (plannedUploads.length >= maxRecordingsPerRun) break;

    const enrichedRecording = enrichRecordingTiming(recording);
    if (!Number.isFinite(enrichedRecording.durationSeconds) || enrichedRecording.durationSeconds <= 0) {
      log(`Skipping recording "${recording.name}" because duration could not be determined.`);
      await softuchiveTracker.noteSkippedRecording(recording.name, "Duration could not be determined.");

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
      await softuchiveTracker.noteSkippedRecording(
        recording.name,
        `Below minimum archive duration (${durationText} < ${Math.floor(minimumArchiveVodDurationSeconds / 60)}m).`
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

    const matchedVod = selectMatchingVod(enrichedRecording, targetTwitchVods);
    if (!matchedVod) {
      log(`No Twitch VOD match found for recording: ${recording.name}`);
      await softuchiveTracker.noteSkippedRecording(recording.name, "No Twitch archive match was found.");
      continue;
    }
    plannedUploads.push({ recording: enrichedRecording, twitchVod: matchedVod });
    log(`Matched recording "${recording.name}" -> Twitch VOD ${matchedVod.id}`);
  }

  await softuchiveTracker.updateQueueFromUploads(plannedUploads);
  await softuchiveTracker.setStage(
    plannedUploads.length > 0 ? "queued" : "backfill",
    plannedUploads.length > 0
      ? `Queued ${plannedUploads.length} upload${plannedUploads.length === 1 ? "" : "s"} for archive processing.`
      : "No new uploads matched; checking backfill and metadata work."
  );

  const uploadsByVod = new Map();
  for (const upload of plannedUploads) {
    const key = String(upload.twitchVod.id);
    if (!uploadsByVod.has(key)) uploadsByVod.set(key, []);
    uploadsByVod.get(key).push(upload);
  }
  for (const group of uploadsByVod.values()) {
    group.sort((a, b) => a.recording.modifiedAtMs - b.recording.modifiedAtMs);
  }

  const uploadVodIds = new Set(uploadsByVod.keys());
  if (!config.dryRun && missingCommentVodIds.length > 0) {
    await softuchiveTracker.setStage("backfill", `Backfilling chat replay for ${missingCommentVodIds.length} archived VOD(s).`);
    for (const vodId of missingCommentVodIds) {
      if (uploadVodIds.has(String(vodId))) continue;

      const commentsPath = path.join(config.commentsDir, `${vodId}.json`);
      const emotesPath = path.join(config.emotesDir, `${vodId}.json`);
      let archiveData;
      try {
        archiveData = await prepareChatArchivePayloads(vodId, channelEmoteSets);
      } catch (error) {
        const previous = state.processedVodIds?.[vodId] || {};
        state.processedVodIds[vodId] = {
          ...previous,
          commentsBackfillLastFailedAt: new Date().toISOString(),
          commentsBackfillLastError: String(error?.message || error),
          updatedAt: new Date().toISOString(),
        };
        await persistState();
        log(
          `Deferred chat replay backfill for VOD ${vodId} after an unavailable or failed Twitch chat export; ` +
            `it will retry after 24 hours. ${error?.message || error}`
        );
        continue;
      }

      await writeJsonFile(commentsPath, archiveData.commentsPayload);
      stagedPaths.push(commentsPath);

      if (!(await fileExists(emotesPath))) {
        await writeJsonFile(emotesPath, archiveData.emotePayload);
        stagedPaths.push(emotesPath);
      }

      const previous = state.processedVodIds?.[vodId] || {};
      const {
        commentsBackfillLastFailedAt: _lastFailureAt,
        commentsBackfillLastError: _lastFailureError,
        ...previousWithoutFailure
      } = previous;
      state.processedVodIds[vodId] = {
        ...previousWithoutFailure,
        commentsBackfilledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await softuchiveTracker.noteBackfilledChat(vodId, archiveData.comments.length, archiveData.embeddedEmotes.length);
      log(
        `Backfilled chat replay for VOD ${vodId} (${archiveData.comments.length} comments, ${archiveData.embeddedEmotes.length} embedded emotes).`
      );
    }
  }

  if (!config.dryRun && missingEmoteVodIds.length > 0) {
    await softuchiveTracker.setStage("backfill", `Backfilling emote metadata for ${missingEmoteVodIds.length} archived VOD(s).`);
    for (const vodId of missingEmoteVodIds) {
      const emotesPath = path.join(config.emotesDir, `${vodId}.json`);
      if (await fileExists(emotesPath)) continue;
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
      await softuchiveTracker.noteBackfilledEmotes(vodId);
      log(`Backfilled emotes for VOD ${vodId}`);
    }
  }

  const needsYouTubeClient = !config.dryRun && (uploadsByVod.size > 0 || vodsNeedingMetadataSync.length > 0);
  youtube = needsYouTubeClient ? await getPipelineYouTube() : youtube;
  if (youtube) {
    await ensureYouTubeCategoryExists(youtube);
  }

  for (const [vodId, uploads] of uploadsByVod.entries()) {
    await softuchiveTracker.throwIfPauseRequested(`Pause requested before Twitch VOD ${vodId} upload batch started.`);
    await softuchiveTracker.setStage(
      "chat-export",
      `Preparing chat replay and upload metadata for Twitch VOD ${vodId} (${uploads.length} part${uploads.length === 1 ? "" : "s"}).`
    );
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
    const archiveData = await prepareChatArchivePayloads(vodId, channelEmoteSets);
    const rawChat = archiveData.rawChat;
    const comments = archiveData.comments;
    const embeddedEmotes = archiveData.embeddedEmotes;
    const emotePayload = archiveData.emotePayload;

    if (config.dryRun) {
      log(`[DRY RUN] Chat export succeeded for VOD ${vodId} (${comments.length} comments, ${embeddedEmotes.length} embedded emotes).`);
      continue;
    }

    await writeJsonFile(commentsPath, archiveData.commentsPayload);
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
      const throwIfSkipRequested = async () => {
        const control = await readSoftuchiveControl(repoRoot);
        if (isSkipRequestedForUpload(control, uploadSessionId)) {
          throw createPipelineControlError("Skip requested for this VOD.", SOFTUCHIVE_SKIP_ERROR_CODE);
        }
      };
      const clearSkipRequestIfCurrent = async () => {
        const control = await readSoftuchiveControl(repoRoot);
        if (!isSkipRequestedForUpload(control, uploadSessionId)) return;
        await writeSoftuchiveControl(repoRoot, {
          skipRequestedUploadSessionId: "",
          skipRequestedAt: null,
        });
      };
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
        await throwIfSkipRequested();
        await softuchiveTracker.throwIfPauseRequested(`Pause requested before ${recording.name} started uploading.`);
        await softuchiveTracker.setStage(
          "uploading",
          `Preparing archive part ${partNumber}/${totalPartsAfterUpload} for ${recording.name}.`
        );
        if (!config.dryRun) {
          const nowIso = new Date().toISOString();
          state.processedFiles[recording.path] = {
            status: "processing",
            twitchVodId: vodId,
            part: partNumber,
            uploadSessionId,
            uploadSessionCreatedAtMs,
            recordingName: recording.name,
            streamDate: currentStreamDate || null,
            title: currentTitle,
            ownerPid: process.pid,
            startedAt: nowIso,
            updatedAt: nowIso,
          };
          await persistState();
        }

        await softuchiveTracker.updateActiveUpload({
          ...buildUploadSessionBase(),
          state: "preparing",
          message: "Preparing VOD upload copy (track 1 audio)",
          percent: 0,
          uploadedBytes: 0,
          totalBytes: recording.size || null,
          stallAttempt: 0,
        });

        await throwIfSkipRequested();
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
        await softuchiveTracker.updateActiveUpload({
          ...buildUploadSessionBase(),
          state: "preparing",
          message: "Prepared track 1 upload copy",
          percent: 0,
          uploadedBytes: 0,
          totalBytes: latestProgress.totalBytes || recording.size || null,
          stallAttempt: 0,
        });

        await throwIfSkipRequested();
        const insertedTitle = currentTitle;
        const insertedDescription = currentDescription;
        let youtubeVideoId = "";
        for (let uploadAttempt = 1; uploadAttempt <= SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS; uploadAttempt++) {
          if (uploadAttempt > 1) {
            latestProgress = {
              percent: 0,
              uploadedBytes: 0,
              totalBytes: latestProgress.totalBytes,
            };
            lastRealtimeUploadProgressPercent = -1;
            lastRealtimeUploadProgressAtMs = 0;
            await softuchiveTracker.updateActiveUpload({
              ...buildUploadSessionBase(),
              state: "uploading",
              message: `Stall detected - attempt ${uploadAttempt}/${SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS}. Restarting upload.`,
              percent: 0,
              uploadedBytes: 0,
              totalBytes: latestProgress.totalBytes || null,
              stallAttempt: uploadAttempt - 1,
            });
            log(
              `Restarting stalled upload for Twitch VOD ${vodId} part ${partNumber} (attempt ${uploadAttempt}/${SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS}).`
            );
          }

          try {
            youtubeVideoId = await uploadRecordingToYouTube({
              youtube,
              recordingFile: uploadRecording,
              title: insertedTitle,
              description: insertedDescription,
              uploadSessionId,
              attemptNumber: uploadAttempt,
              maxAttempts: SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS,
              onProgress: ({ percent, uploadedBytes, totalBytes, uploadMbps, uploadPaused, uploadThrottleMbps }) => {
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
                const safeUploadedBytes = Number.isFinite(uploadedBytes) ? Math.floor(uploadedBytes) : null;
                const safeTotalBytes = Number.isFinite(totalBytes) ? Math.floor(totalBytes) : null;
                const bytesPerMs =
                  safeUploadedBytes && safeUploadedBytes > 0 ? safeUploadedBytes / Math.max(1, nowMs - uploadSessionCreatedAtMs) : 0;
                const estimatedRemainingMs =
                  bytesPerMs > 0 && safeTotalBytes && safeTotalBytes > safeUploadedBytes
                    ? Math.ceil((safeTotalBytes - safeUploadedBytes) / bytesPerMs)
                    : null;
                const normalizedUploadThrottleMbps =
                  Number.isFinite(Number(uploadThrottleMbps)) && Number(uploadThrottleMbps) > 0 ? Number(uploadThrottleMbps) : null;
                const uploadMessage =
                  uploadPaused === true
                    ? "Upload speed control is paused"
                    : normalizedUploadThrottleMbps
                      ? `Uploading VOD with ${normalizedUploadThrottleMbps} Mbps limit`
                      : uploadAttempt > 1
                        ? `Uploading VOD after stall recovery (attempt ${uploadAttempt}/${SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS})`
                        : "Uploading VOD";

                void softuchiveTracker.updateActiveUpload({
                  ...buildUploadSessionBase(),
                  state: "uploading",
                  message: uploadMessage,
                  percent: safePercent,
                  uploadedBytes: safeUploadedBytes,
                  totalBytes: safeTotalBytes,
                  estimatedRemainingMs,
                  uploadMbps: Number.isFinite(Number(uploadMbps)) ? Math.max(0, Number(uploadMbps)) : null,
                  uploadPaused: uploadPaused === true,
                  uploadThrottleMbps: normalizedUploadThrottleMbps,
                  stallAttempt: uploadAttempt - 1,
                });

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
                    uploadedBytes: safeUploadedBytes,
                    totalBytes: safeTotalBytes,
                    uploadMbps: Number.isFinite(Number(uploadMbps)) ? Math.max(0, Number(uploadMbps)) : null,
                    uploadThrottleMbps: normalizedUploadThrottleMbps,
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
            break;
          } catch (error) {
            if (isSoftuchiveSkipError(error)) {
              throw error;
            }
            if (isSoftuchiveUploadStallError(error) && uploadAttempt < SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS) {
              await softuchiveTracker.updateActiveUpload({
                ...buildUploadSessionBase(),
                state: "uploading",
                message: `Stall detected - attempt ${uploadAttempt}/${SOFTUCHIVE_MAX_UPLOAD_ATTEMPTS}. Restarting upload.`,
                percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : 0,
                uploadedBytes: 0,
                totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
                stallAttempt: uploadAttempt,
              });
              continue;
            }
            throw error;
          }
        }

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

        await softuchiveTracker.setStage("finalizing", `Finalizing archive metadata for Twitch VOD ${vodId} part ${partNumber}.`);
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
          await softuchiveTracker.noteSkippedRecording(
            recording.name,
            `Uploaded part was shorter than the minimum archive duration (${details.durationSeconds}s).`
          );
          await softuchiveTracker.updateActiveUpload({
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

        const targetYouTubePrivacyStatus = String(config.youtubePrivacyStatus || "private").trim().toLowerCase() || "private";
        if (targetYouTubePrivacyStatus !== "private") {
          const privacyUpdated = await setYouTubeVideoPrivacyStatus(youtube, youtubeVideoId, targetYouTubePrivacyStatus);
          if (!privacyUpdated) {
            fail(`Unable to set YouTube privacy status for ${youtubeVideoId} to ${targetYouTubePrivacyStatus}`);
          }
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
        await softuchiveTracker.noteArchivedPart({
          twitchVodId: String(vodId),
          youtubeVideoId,
          partNumber,
          title: currentTitle,
          durationSeconds: details.durationSeconds || 0,
        });
        await softuchiveTracker.updateActiveUpload({
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
        const paused = isSoftuchivePauseError(error);
        const skipped = isSoftuchiveSkipError(error);
        if (skipped) {
          if (!config.dryRun) {
            state.processedFiles[recording.path] = {
              ...state.processedFiles[recording.path],
              status: "skipped_manual",
              twitchVodId: vodId,
              part: partNumber,
              updatedAt: new Date().toISOString(),
              skippedAt: new Date().toISOString(),
              reason: "Manually skipped in Softuchive.",
            };
            await persistState();
          }
          await clearSkipRequestIfCurrent();
          await postRealtimeUploadStatus({
            ...buildUploadSessionBase(),
            state: "skipped",
            message: "VOD skipped from Softuchive",
            percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : null,
            uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
            totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          });
          await softuchiveTracker.noteSkippedRecording(recording.name, "Manually skipped in Softuchive.");
          await softuchiveTracker.updateActiveUpload({
            ...buildUploadSessionBase(),
            state: "skipped",
            message: "VOD skipped from Softuchive",
            percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : null,
            uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
            totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
            stallAttempt: 0,
          });
          log(`Skipped Twitch VOD ${vodId} part ${partNumber} from Softuchive control.`);
          continue;
        }
        if (!config.dryRun) {
          state.processedFiles[recording.path] = {
            ...state.processedFiles[recording.path],
            status: paused ? "paused" : "error",
            twitchVodId: vodId,
            part: partNumber,
            updatedAt: new Date().toISOString(),
            error: error.message,
          };
          await persistState();
        }
        await postRealtimeUploadStatus({
          ...buildUploadSessionBase(),
          state: paused ? "paused" : "error",
          message: paused ? `Upload paused: ${error.message}` : `Upload failed: ${error.message}`,
          percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : null,
          uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
          totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
        });
        await softuchiveTracker.updateActiveUpload({
          ...buildUploadSessionBase(),
          state: paused ? "paused" : "error",
          message: paused ? "Archive paused. Resume will restart the current part if needed." : `Upload failed: ${error.message}`,
          percent: Number.isFinite(latestProgress.percent) ? Math.max(0, Math.min(100, Math.floor(latestProgress.percent))) : null,
          uploadedBytes: Number.isFinite(latestProgress.uploadedBytes) ? Math.floor(latestProgress.uploadedBytes) : null,
          totalBytes: Number.isFinite(latestProgress.totalBytes) ? Math.floor(latestProgress.totalBytes) : null,
          stallAttempt: 0,
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

    const archivedYouTubeParts = (Array.isArray(vodEntry.youtube) ? vodEntry.youtube : []).filter(
      (part) => String(part?.type || "vod") === "vod" && part?.id
    );
    if (archivedYouTubeParts.length === 0) {
      if (!config.dryRun) {
        await fs.rm(commentsPath, { force: true }).catch(() => {});
        await fs.rm(emotesPath, { force: true }).catch(() => {});
        for (let index = stagedPaths.length - 1; index >= 0; index--) {
          if (stagedPaths[index] === commentsPath || stagedPaths[index] === emotesPath) {
            stagedPaths.splice(index, 1);
          }
        }
      }
      log(`No YouTube parts were archived for Twitch VOD ${vodId}; skipping archive metadata sync.`);
      continue;
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

    await softuchiveTracker.setStage("metadata", `Syncing archive metadata for Twitch VOD ${vodId}.`);
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
    await softuchiveTracker.setStage("metadata", "Syncing metadata templates for existing archive VODs.");
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
    await softuchiveTracker.setStage("publishing", "Committing and pushing archive data changes.");
    await stageAndPushArchiveData(stagedPaths, "chore: update archive vod data");
  }

  await softuchiveTracker.finish({
    status: "completed",
    message:
      config.dryRun
        ? `[DRY RUN] Archive poll evaluated ${Array.from(uploadsByVod.values()).reduce((sum, items) => sum + items.length, 0)} queued part(s).`
        : uploadsByVod.size > 0
        ? `Archive poll complete. Uploaded ${Array.from(uploadsByVod.values()).reduce((sum, items) => sum + items.length, 0)} part(s).`
        : "Archive poll complete.",
  });
};

const run = async () => {
  await loadSoftuchiveSettingsIntoConfig();
  const releaseRunLock = await acquirePipelineRunLock(config.runLockPath);
  if (!releaseRunLock) {
    const runtime = await readSoftuchiveRuntime(repoRoot, { archiveFolder: config.recordingsDir });
    if (runtime.run?.active) {
      log("Another local archive pipeline run is already active. Skipping this invocation.");
      return;
    }

    await writeSoftuchiveRuntime(
      repoRoot,
      {
        ...runtime,
        run: {
          ...(runtime.run || {}),
          active: false,
          status: "skipped",
          trigger: pipelineTrigger,
          stage: "idle",
          message: "Another local archive pipeline run is already active. Skipping this invocation.",
          lastPollStatus: "skipped",
          lastPollCompletedAt: new Date().toISOString(),
        },
      },
      { archiveFolder: config.recordingsDir }
    );
    log("Another local archive pipeline run is already active. Skipping this invocation.");
    return;
  }

  try {
    if (syncMetadataOnlyMode) {
      await runMetadataSyncOnly();
      return;
    }

    if (syncYouTubeVisibilityOnlyMode) {
      await runYouTubeVisibilitySyncOnly();
      return;
    }

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
      if (softuchiveTracker) {
        await softuchiveTracker.finish({
          status: isSoftuchivePauseError(error) ? "paused" : "error",
          message: isSoftuchivePauseError(error)
            ? "Archive paused. Resume will restart the current part if needed."
            : `Archive poll failed: ${error.message}`,
          error,
        });
      }
      await writeObsDockUploadStatus({
        visible: true,
        state: isSoftuchivePauseError(error) ? "paused" : "error",
        message: isSoftuchivePauseError(error) ? "VOD upload paused" : `VOD upload error: ${error.message}`,
        percent: null,
        hide_after_ms: 0,
      });
    } catch {}
    console.error(error);
    process.exit(isSoftuchivePauseError(error) ? 0 : 1);
  });
