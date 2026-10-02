import fs from "node:fs/promises";
import path from "node:path";
import { serializeFileUpdate, writeJsonFileAtomic } from "./pipeline_file_io.mjs";
import { acquireArchiveFileLock } from "./archive_database.mjs";

export const SOFTUCHIVE_SCHEMA_VERSION = 1;

const DEFAULT_POLL_INTERVAL_MINUTES = 15;
const DEFAULT_RECENT_EVENT_LIMIT = 120;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const recordOrEmpty = (value) => isRecord(value) ? value : {};
const normalizedText = (value, fallback = "") => typeof value === "string" ? value : fallback;

const normalizeNumber = (value, fallback = null, { max = Number.MAX_SAFE_INTEGER, integer = false } = {}) => {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.max(0, Math.min(max, parsed));
  return integer ? Math.floor(bounded) : bounded;
};

const normalizePollingInterval = (value) =>
  Math.max(1, normalizeNumber(value, DEFAULT_POLL_INTERVAL_MINUTES, { max: 720, integer: true }));

const resolveArchiveFolder = (value, fallback) => {
  const raw = normalizedText(value).trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(fallback, raw);
};

export const resolveSoftuchivePaths = (repoRoot) => {
  const stateDir = path.join(repoRoot, "scripts", ".state");
  return {
    stateDir,
    settingsPath: path.join(stateDir, "softuchive-settings.json"),
    runtimePath: path.join(stateDir, "softuchive-runtime.json"),
    controlPath: path.join(stateDir, "softuchive-control.json"),
    summaryLogPath: path.join(stateDir, "softuchive-history.log"),
    taskLogPath: path.join(stateDir, "archive-task.log"),
  };
};

export const defaultSoftuchiveSettings = ({ archiveFolder } = {}) => ({
  schemaVersion: SOFTUCHIVE_SCHEMA_VERSION,
  pollingIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
  pollOnObsCloseEnabled: false,
  archiveFolder: archiveFolder || "",
  updatedAt: new Date().toISOString(),
});

export const defaultSoftuchiveRuntime = ({ archiveFolder, taskLogPath, summaryLogPath } = {}) => ({
  schemaVersion: SOFTUCHIVE_SCHEMA_VERSION,
  app: {
    archiveFolder: archiveFolder || "",
    taskLogPath: taskLogPath || "",
    summaryLogPath: summaryLogPath || "",
  },
  run: {
    active: false,
    status: "idle",
    trigger: null,
    stage: "idle",
    message: "Waiting for next poll.",
    startedAt: null,
    completedAt: null,
    lastPollStartedAt: null,
    lastPollCompletedAt: null,
    lastPollStatus: null,
    queue: {
      total: 0,
      remaining: 0,
      totalBytes: 0,
      remainingBytes: 0,
      estimatedRemainingMs: null,
    },
    current: null,
    uploads: [],
    summary: null,
    error: null,
  },
  events: [],
  updatedAt: new Date().toISOString(),
});

export const defaultSoftuchiveControl = () => ({
  schemaVersion: SOFTUCHIVE_SCHEMA_VERSION,
  pauseRequested: false,
  uploadPaused: false,
  uploadThrottleMbps: null,
  skipRequestedUploadSessionId: "",
  skipRequestedAt: null,
  updatedAt: new Date().toISOString(),
});

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const stateFileError = (filePath, code, detail) => Object.assign(
  new Error(`Cannot use ${path.basename(filePath)}: ${detail}`),
  { code }
);

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw stateFileError(filePath, "SOFTUCHIVE_STATE_READ_FAILED", "check file permissions and disk access, then retry.");
  }
};

const readJsonFile = async (filePath, fallback) => {
  let handle;
  let failed = false;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw stateFileError(filePath, "SOFTUCHIVE_STATE_INVALID", "expected a JSON file. Restore the state file before retrying.");
    }
    if (stat.size > MAX_STATE_FILE_BYTES) {
      throw stateFileError(filePath, "SOFTUCHIVE_STATE_TOO_LARGE", "state exceeds the 8 MiB limit. Back it up and repair it before retrying.");
    }
    // Limit the actual read too: an external writer can grow the file after stat.
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ start: 0, end: MAX_STATE_FILE_BYTES, autoClose: false })) {
      size += chunk.length;
      if (size > MAX_STATE_FILE_BYTES) {
        throw stateFileError(filePath, "SOFTUCHIVE_STATE_TOO_LARGE", "state exceeds the 8 MiB limit. Back it up and repair it before retrying.");
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks, size).toString("utf8").replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // JSON parser messages can contain the file contents, including secrets.
      throw stateFileError(filePath, "SOFTUCHIVE_STATE_INVALID", "invalid JSON. Repair or restore this state file before retrying.");
    }
    if (!isRecord(parsed)) {
      throw stateFileError(filePath, "SOFTUCHIVE_STATE_INVALID", "expected a JSON object. Repair or restore this state file before retrying.");
    }
    return parsed;
  } catch (error) {
    failed = true;
    if (error.code === "ENOENT") return fallback;
    if (String(error.code || "").startsWith("SOFTUCHIVE_STATE_")) throw error;
    throw stateFileError(filePath, "SOFTUCHIVE_STATE_READ_FAILED", "check file permissions and disk access, then retry.");
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch {
        if (!failed) throw stateFileError(filePath, "SOFTUCHIVE_STATE_READ_FAILED", "the state file could not be closed. Check disk access and retry.");
      }
    }
  }
};

const writeJsonFile = async (filePath, payload) => {
  if (Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`, "utf8") > MAX_STATE_FILE_BYTES) {
    throw stateFileError(filePath, "SOFTUCHIVE_STATE_TOO_LARGE", "state exceeds the 8 MiB limit. Reduce the snapshot size before retrying.");
  }
  await writeJsonFileAtomic(filePath, payload);
};

const normalizeUploadThrottleMbps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(10000, Math.round(parsed * 100) / 100));
};

const normalizeUpload = (value) => {
  if (!isRecord(value)) return null;
  const normalized = { ...value };
  // A missing measurement is unknown, not zero. Keep resume metadata and any
  // fields from newer desktop versions while sanitizing only known counters.
  for (const field of ["uploadedBytes", "totalBytes", "estimatedRemainingMs", "createdAtMs", "updatedAtMs", "stallAttempt"]) {
    if (Object.hasOwn(value, field)) normalized[field] = normalizeNumber(value[field], null, { integer: true });
  }
  if (Object.hasOwn(value, "percent")) normalized.percent = normalizeNumber(value.percent, null, { max: 100 });
  if (Object.hasOwn(value, "uploadMbps")) normalized.uploadMbps = normalizeNumber(value.uploadMbps);
  if (normalized.totalBytes > 0 && normalized.uploadedBytes > normalized.totalBytes) {
    normalized.uploadedBytes = normalized.totalBytes;
  }
  return normalized;
};

const normalizeRuntime = (runtime) => ({
  ...runtime,
  run: {
    ...runtime.run,
    active: runtime.run.active === true,
    queue: {
      ...runtime.run.queue,
      ...Object.fromEntries(["total", "remaining", "totalBytes", "remainingBytes"].map((field) => [
        field, normalizeNumber(runtime.run.queue[field], 0, { integer: true }),
      ])),
      estimatedRemainingMs: normalizeNumber(runtime.run.queue.estimatedRemainingMs, null, { integer: true }),
    },
    current: normalizeUpload(runtime.run.current),
    uploads: runtime.run.uploads.filter(isRecord).map(normalizeUpload),
  },
  events: runtime.events.filter(isRecord).slice(-DEFAULT_RECENT_EVENT_LIMIT),
});

const normalizeControl = (control) => {
  const skipRequestedUploadSessionId = normalizedText(control.skipRequestedUploadSessionId).trim();
  return {
    ...control,
    pauseRequested: control.pauseRequested === true,
    uploadPaused: control.uploadPaused === true,
    uploadThrottleMbps: normalizeUploadThrottleMbps(control.uploadThrottleMbps),
    skipRequestedUploadSessionId,
    skipRequestedAt: skipRequestedUploadSessionId ? normalizedText(control.skipRequestedAt) || null : null,
  };
};

const validateControlFields = (control, controlPath) => {
  for (const field of ["pauseRequested", "uploadPaused"]) {
    if (Object.hasOwn(control, field) && typeof control[field] !== "boolean") {
      throw stateFileError(controlPath, "SOFTUCHIVE_STATE_INVALID", `${field} must be true or false. Repair this control value before retrying.`);
    }
  }
  for (const field of ["skipRequestedUploadSessionId", "skipRequestedAt"]) {
    if (Object.hasOwn(control, field) && control[field] !== null && typeof control[field] !== "string") {
      throw stateFileError(controlPath, "SOFTUCHIVE_STATE_INVALID", `${field} must be text. Repair this control value before retrying.`);
    }
  }
  if (Object.hasOwn(control, "uploadThrottleMbps") && control.uploadThrottleMbps !== null) {
    const value = control.uploadThrottleMbps;
    if (!["string", "number"].includes(typeof value) || !Number.isFinite(Number(value))) {
      throw stateFileError(controlPath, "SOFTUCHIVE_STATE_INVALID", "uploadThrottleMbps must be a finite number or null. Repair this control value before retrying.");
    }
  }
};

const validateSettingsFields = (settings, settingsPath) => {
  if (Object.hasOwn(settings, "archiveFolder") && typeof settings.archiveFolder !== "string") {
    throw stateFileError(settingsPath, "SOFTUCHIVE_STATE_INVALID", "archiveFolder must be a path string. Repair this setting before retrying.");
  }
  if (Object.hasOwn(settings, "pollOnObsCloseEnabled") && typeof settings.pollOnObsCloseEnabled !== "boolean") {
    throw stateFileError(settingsPath, "SOFTUCHIVE_STATE_INVALID", "pollOnObsCloseEnabled must be true or false. Repair this setting before retrying.");
  }
};

const serializeControlUpdate = (filePath, update) => serializeFileUpdate(filePath, async () => {
  let release;
  try {
    release = await acquireArchiveFileLock(filePath);
  } catch (error) {
    if (error.code === "ARCHIVE_LOCK_BUSY") {
      throw stateFileError(filePath, "SOFTUCHIVE_STATE_BUSY", "another process is updating controls. Retry shortly.");
    }
    throw stateFileError(filePath, "SOFTUCHIVE_STATE_WRITE_FAILED", "check file permissions and disk access, then retry.");
  }
  try {
    return await update();
  } finally {
    await release();
  }
});

export const ensureSoftuchiveStateFiles = async (repoRoot, { archiveFolder } = {}) => {
  const paths = resolveSoftuchivePaths(repoRoot);
  await ensureDirectory(paths.stateDir);

  const settings = await readSoftuchiveSettings(repoRoot, { archiveFolder });
  const runtime = await readSoftuchiveRuntime(repoRoot, {
    archiveFolder: settings.archiveFolder || archiveFolder || "",
  });
  const control = await readSoftuchiveControl(repoRoot);

  for (const [filePath, initial] of [
    [paths.settingsPath, settings],
    [paths.runtimePath, runtime],
    [paths.controlPath, control],
  ]) {
    const serializeUpdate = filePath === paths.controlPath ? serializeControlUpdate : serializeFileUpdate;
    await serializeUpdate(filePath, async () => {
      if (!(await fileExists(filePath))) await writeJsonFile(filePath, initial);
    });
  }

  return { paths, settings, runtime, control };
};

export const readSoftuchiveSettings = async (repoRoot, { archiveFolder } = {}) => {
  const { settingsPath } = resolveSoftuchivePaths(repoRoot);
  const fallbackArchiveFolder = archiveFolder || "";
  const defaults = defaultSoftuchiveSettings({ archiveFolder: fallbackArchiveFolder });
  const current = await readJsonFile(settingsPath, defaults);
  validateSettingsFields(current, settingsPath);
  return {
    ...defaults,
    ...current,
    pollingIntervalMinutes: normalizePollingInterval(current.pollingIntervalMinutes),
    pollOnObsCloseEnabled: current.pollOnObsCloseEnabled === true,
    archiveFolder: resolveArchiveFolder(
      current?.archiveFolder,
      fallbackArchiveFolder && path.isAbsolute(fallbackArchiveFolder) ? fallbackArchiveFolder : repoRoot
    ),
  };
};

export const writeSoftuchiveSettings = async (repoRoot, nextSettings, { archiveFolder } = {}) => {
  const { settingsPath } = resolveSoftuchivePaths(repoRoot);
  validateSettingsFields(recordOrEmpty(nextSettings), settingsPath);
  return serializeFileUpdate(settingsPath, async () => {
    const previous = await readSoftuchiveSettings(repoRoot, { archiveFolder });
    const merged = {
      ...previous,
      ...recordOrEmpty(nextSettings),
      pollingIntervalMinutes: normalizePollingInterval(nextSettings?.pollingIntervalMinutes ?? previous.pollingIntervalMinutes),
      pollOnObsCloseEnabled: (nextSettings?.pollOnObsCloseEnabled ?? previous.pollOnObsCloseEnabled) === true,
      archiveFolder: resolveArchiveFolder(
        nextSettings?.archiveFolder ?? previous.archiveFolder,
        archiveFolder && path.isAbsolute(archiveFolder) ? archiveFolder : repoRoot
      ),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(settingsPath, merged);
    return merged;
  });
};

export const readSoftuchiveRuntime = async (repoRoot, { archiveFolder } = {}) => {
  const { runtimePath, taskLogPath, summaryLogPath } = resolveSoftuchivePaths(repoRoot);
  const defaults = defaultSoftuchiveRuntime({
    archiveFolder: archiveFolder || "",
    taskLogPath,
    summaryLogPath,
  });
  const current = await readJsonFile(runtimePath, defaults);
  const merged = {
    ...defaults,
    ...current,
    app: {
      ...defaults.app,
      ...recordOrEmpty(current?.app),
      archiveFolder: current?.app?.archiveFolder || archiveFolder || defaults.app.archiveFolder,
      taskLogPath,
      summaryLogPath,
    },
    run: {
      ...defaults.run,
      ...recordOrEmpty(current?.run),
      queue: {
        ...defaults.run.queue,
        ...recordOrEmpty(current?.run?.queue),
      },
      uploads: Array.isArray(current?.run?.uploads) ? current.run.uploads : [],
    },
    events: Array.isArray(current?.events) ? current.events.slice(-DEFAULT_RECENT_EVENT_LIMIT) : [],
    updatedAt: current?.updatedAt || defaults.updatedAt,
  };
  return normalizeRuntime(merged);
};

export const writeSoftuchiveRuntime = async (repoRoot, nextRuntime, { archiveFolder } = {}) => {
  const { runtimePath, taskLogPath, summaryLogPath } = resolveSoftuchivePaths(repoRoot);
  return serializeFileUpdate(runtimePath, async () => {
    const previous = await readSoftuchiveRuntime(repoRoot, { archiveFolder });
    const merged = normalizeRuntime({
      ...previous,
      ...recordOrEmpty(nextRuntime),
      app: {
        ...previous.app,
        ...recordOrEmpty(nextRuntime?.app),
        archiveFolder: nextRuntime?.app?.archiveFolder || previous.app.archiveFolder || archiveFolder || "",
        taskLogPath,
        summaryLogPath,
      },
      run: {
        ...previous.run,
        ...recordOrEmpty(nextRuntime?.run),
        queue: {
          ...previous.run.queue,
          ...recordOrEmpty(nextRuntime?.run?.queue),
        },
        uploads: Array.isArray(nextRuntime?.run?.uploads) ? nextRuntime.run.uploads : previous.run.uploads,
      },
      events: Array.isArray(nextRuntime?.events) ? nextRuntime.events.slice(-DEFAULT_RECENT_EVENT_LIMIT) : previous.events,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonFile(runtimePath, merged);
    return merged;
  });
};

export const readSoftuchiveControl = async (repoRoot) => {
  const { controlPath } = resolveSoftuchivePaths(repoRoot);
  const defaults = defaultSoftuchiveControl();
  const current = await readJsonFile(controlPath, defaults);
  validateControlFields(current, controlPath);
  return normalizeControl({
    ...defaults,
    ...current,
  });
};

export const writeSoftuchiveControl = async (repoRoot, nextControl) => {
  const { controlPath } = resolveSoftuchivePaths(repoRoot);
  validateControlFields(recordOrEmpty(nextControl), controlPath);
  return serializeControlUpdate(controlPath, async () => {
    const previous = await readSoftuchiveControl(repoRoot);
    const merged = normalizeControl({
      ...previous,
      ...recordOrEmpty(nextControl),
      updatedAt: new Date().toISOString(),
    });
    await writeJsonFile(controlPath, merged);
    return merged;
  });
};

// The comparison must happen under the same cross-process lock as UI control
// patches, or completion of one upload can erase a newer skip request.
export const clearSoftuchiveSkipRequest = async (repoRoot, expectedSessionId) => {
  const { controlPath } = resolveSoftuchivePaths(repoRoot);
  const sessionId = normalizedText(expectedSessionId).trim();
  return serializeControlUpdate(controlPath, async () => {
    const previous = await readSoftuchiveControl(repoRoot);
    if (!sessionId || previous.skipRequestedUploadSessionId !== sessionId) return previous;
    const next = { ...previous, skipRequestedUploadSessionId: "", skipRequestedAt: null, updatedAt: new Date().toISOString() };
    await writeJsonFile(controlPath, next);
    return next;
  });
};

export const appendSoftuchiveSummary = async (repoRoot, lines) => {
  const { summaryLogPath } = resolveSoftuchivePaths(repoRoot);
  await ensureDirectory(path.dirname(summaryLogPath));
  const text = Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines || "");
  if (!text.trim()) return summaryLogPath;
  await fs.appendFile(summaryLogPath, `${text.trim()}\n\n`, "utf8");
  return summaryLogPath;
};
