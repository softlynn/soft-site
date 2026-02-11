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

const config = {
  recordingsDir: process.env.LOCAL_RECORDINGS_DIR || "Z:/Stream Archives",
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "softu1",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  youtubeClientSecretPath: process.env.YOUTUBE_CLIENT_SECRET_PATH || "C:/Users/Alex2/Documents/youtube_client_secret.json",
  youtubeTokenPath: process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json"),
  youtubePrivacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "private",
  vodsDataPath: process.env.ARCHIVE_VODS_PATH || path.join(repoRoot, "public", "data", "vods.json"),
  commentsDir: process.env.ARCHIVE_COMMENTS_DIR || path.join(repoRoot, "public", "data", "comments"),
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

const loadYoutubeAuthClient = async () => {
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
  return authClient;
};

const uploadRecordingToYouTube = async (authClient, recordingFile, twitchVod) => {
  const youtube = google.youtube({ version: "v3", auth: authClient });

  const recordedDate = new Date(twitchVod.created_at || Date.now());
  const isoDate = recordedDate.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const title = twitchVod.title || path.parse(recordingFile.name).name;
  const descriptionLines = [
    `Auto-archived from Twitch stream: https://www.twitch.tv/videos/${twitchVod.id}`,
    `Stream date: ${isoDate}`,
  ];

  log(`Uploading to YouTube: ${recordingFile.path}`);
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description: descriptionLines.join("\n"),
        categoryId: "20",
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

const upsertVod = (vods, entry) => {
  const index = vods.findIndex((vod) => String(vod.id) === String(entry.id));
  if (index >= 0) {
    vods[index] = { ...vods[index], ...entry };
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

const selectMatchingVod = (recordingFile, twitchVods, existingVodIds, processedVodIds) => {
  const unprocessed = twitchVods.filter((vod) => !existingVodIds.has(String(vod.id)) && !processedVodIds.has(String(vod.id)));
  if (unprocessed.length === 0) return null;

  const fileTime = recordingFile.modifiedAtMs;
  const candidates = unprocessed
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

const buildVodEntry = ({ twitchVod, youtubeVideoId, chatJson }) => {
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
    youtube: [
      {
        id: youtubeVideoId,
        type: "vod",
        duration: durationSeconds,
        part: 1,
        thumbnail_url: thumbnail,
      },
    ],
    stream_id: twitchVod.stream_id || null,
    drive: [],
    platform: "twitch",
    chapters,
    games: [],
    createdAt: twitchVod.created_at,
    updatedAt: new Date().toISOString(),
  };
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
  await ensureDirectory(path.dirname(config.statePath));
  await ensureDirectory(config.tmpDir);

  const state = await readJsonFile(config.statePath, {
    processedFiles: {},
    processedVodIds: {},
  });

  const existingVods = await readJsonFile(config.vodsDataPath, []);
  const existingVodIds = new Set(existingVods.map((vod) => String(vod.id)));
  const processedVodIds = new Set(Object.keys(state.processedVodIds || {}));

  const now = Date.now();
  const minAgeMs = config.minRecordingAgeMinutes * 60 * 1000;
  const recordings = (await listRecordingFiles(config.recordingsDir))
    .filter((file) => now - file.modifiedAtMs >= minAgeMs)
    .filter((file) => !(state.processedFiles?.[file.path]?.status === "completed"))
    .sort((a, b) => a.modifiedAtMs - b.modifiedAtMs);

  if (recordings.length === 0) {
    log("No completed recordings ready for processing.");
    return;
  }

  const twitchAccessToken = await fetchTwitchAppAccessToken();
  const twitchUser = await fetchTwitchUser(twitchAccessToken);
  const twitchVods = await fetchTwitchArchives(twitchAccessToken, twitchUser.id);
  if (twitchVods.length === 0) {
    log("No Twitch archives found yet.");
    return;
  }

  const authClient = config.dryRun ? null : await loadYoutubeAuthClient();
  const targets = recordings.slice(0, Math.max(1, config.maxRecordingsPerRun));
  const stagedPaths = [];

  for (const recording of targets) {
    log(`Evaluating recording: ${recording.path}`);

    const matchedVod = selectMatchingVod(recording, twitchVods, existingVodIds, processedVodIds);
    if (!matchedVod) {
      log(`No unprocessed Twitch VOD match found for recording: ${recording.name}`);
      continue;
    }

    const vodId = String(matchedVod.id);
    const commentsPath = path.join(config.commentsDir, `${vodId}.json`);
    const rawChatPath = path.join(config.tmpDir, `${vodId}-chat-raw.json`);

    log(`Matched recording "${recording.name}" -> Twitch VOD ${vodId}`);
    await downloadTwitchChatJson(vodId, rawChatPath);

    const rawChat = await readJsonFile(rawChatPath, {});
    const comments = normalizeChatComments(rawChat);
    if (config.dryRun) {
      log(`[DRY RUN] Chat export succeeded for VOD ${vodId} (${comments.length} comments).`);
      continue;
    }

    await writeJsonFile(commentsPath, {
      source: "twitchdownloader",
      twitchVodId: vodId,
      generatedAt: new Date().toISOString(),
      comments,
    });
    stagedPaths.push(commentsPath);

    const youtubeVideoId = await uploadRecordingToYouTube(authClient, recording, matchedVod);
    const vodEntry = buildVodEntry({
      twitchVod: matchedVod,
      youtubeVideoId,
      chatJson: rawChat,
    });

    upsertVod(existingVods, vodEntry);
    existingVodIds.add(vodId);
    processedVodIds.add(vodId);

    state.processedFiles[recording.path] = {
      status: "completed",
      twitchVodId: vodId,
      youtubeVideoId,
      processedAt: new Date().toISOString(),
    };
    state.processedVodIds[vodId] = {
      youtubeVideoId,
      recordingPath: recording.path,
      processedAt: new Date().toISOString(),
    };

    await writeJsonFile(config.vodsDataPath, existingVods);
    await writeJsonFile(config.statePath, state);
    stagedPaths.push(config.vodsDataPath);

    log(`Completed pipeline for Twitch VOD ${vodId} -> YouTube ${youtubeVideoId}`);
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
