import fs from "node:fs/promises";
import path from "node:path";

export const SOFTUCHIVE_SCHEMA_VERSION = 1;

const DEFAULT_POLL_INTERVAL_MINUTES = 15;
const DEFAULT_RECENT_EVENT_LIMIT = 120;

const resolveArchiveFolder = (value, fallback) => {
  const raw = String(value || "").trim();
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
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (filePath, payload) => {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const normalizeUploadThrottleMbps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(10000, Math.round(parsed * 100) / 100));
};

export const ensureSoftuchiveStateFiles = async (repoRoot, { archiveFolder } = {}) => {
  const paths = resolveSoftuchivePaths(repoRoot);
  await ensureDirectory(paths.stateDir);

  const settings = await readSoftuchiveSettings(repoRoot, { archiveFolder });
  const runtime = await readSoftuchiveRuntime(repoRoot, {
    archiveFolder: settings.archiveFolder || archiveFolder || "",
  });
  const control = await readSoftuchiveControl(repoRoot);

  if (!(await fileExists(paths.settingsPath))) {
    await writeJsonFile(paths.settingsPath, settings);
  }
  if (!(await fileExists(paths.runtimePath))) {
    await writeJsonFile(paths.runtimePath, runtime);
  }
  if (!(await fileExists(paths.controlPath))) {
    await writeJsonFile(paths.controlPath, control);
  }

  return { paths, settings, runtime, control };
};

export const readSoftuchiveSettings = async (repoRoot, { archiveFolder } = {}) => {
  const { settingsPath } = resolveSoftuchivePaths(repoRoot);
  const fallbackArchiveFolder = archiveFolder || "";
  const defaults = defaultSoftuchiveSettings({ archiveFolder: fallbackArchiveFolder });
  const current = await readJsonFile(settingsPath, defaults);
  return {
    ...defaults,
    ...(current && typeof current === "object" ? current : {}),
    archiveFolder: resolveArchiveFolder(
      current?.archiveFolder,
      fallbackArchiveFolder && path.isAbsolute(fallbackArchiveFolder) ? fallbackArchiveFolder : repoRoot
    ),
  };
};

export const writeSoftuchiveSettings = async (repoRoot, nextSettings, { archiveFolder } = {}) => {
  const { settingsPath } = resolveSoftuchivePaths(repoRoot);
  const previous = await readSoftuchiveSettings(repoRoot, { archiveFolder });
  const merged = {
    ...previous,
    ...(nextSettings && typeof nextSettings === "object" ? nextSettings : {}),
    archiveFolder: resolveArchiveFolder(
      nextSettings?.archiveFolder ?? previous.archiveFolder,
      archiveFolder && path.isAbsolute(archiveFolder) ? archiveFolder : repoRoot
    ),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(settingsPath, merged);
  return merged;
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
    ...(current && typeof current === "object" ? current : {}),
    app: {
      ...defaults.app,
      ...(current?.app && typeof current.app === "object" ? current.app : {}),
      archiveFolder: current?.app?.archiveFolder || archiveFolder || defaults.app.archiveFolder,
      taskLogPath,
      summaryLogPath,
    },
    run: {
      ...defaults.run,
      ...(current?.run && typeof current.run === "object" ? current.run : {}),
      queue: {
        ...defaults.run.queue,
        ...(current?.run?.queue && typeof current.run.queue === "object" ? current.run.queue : {}),
      },
      uploads: Array.isArray(current?.run?.uploads) ? current.run.uploads : [],
    },
    events: Array.isArray(current?.events) ? current.events.slice(-DEFAULT_RECENT_EVENT_LIMIT) : [],
    updatedAt: current?.updatedAt || defaults.updatedAt,
  };
  return merged;
};

export const writeSoftuchiveRuntime = async (repoRoot, nextRuntime, { archiveFolder } = {}) => {
  const { runtimePath, taskLogPath, summaryLogPath } = resolveSoftuchivePaths(repoRoot);
  const previous = await readSoftuchiveRuntime(repoRoot, { archiveFolder });
  const merged = {
    ...previous,
    ...(nextRuntime && typeof nextRuntime === "object" ? nextRuntime : {}),
    app: {
      ...previous.app,
      ...(nextRuntime?.app && typeof nextRuntime.app === "object" ? nextRuntime.app : {}),
      archiveFolder: nextRuntime?.app?.archiveFolder || previous.app.archiveFolder || archiveFolder || "",
      taskLogPath,
      summaryLogPath,
    },
    run: {
      ...previous.run,
      ...(nextRuntime?.run && typeof nextRuntime.run === "object" ? nextRuntime.run : {}),
      queue: {
        ...previous.run.queue,
        ...(nextRuntime?.run?.queue && typeof nextRuntime.run.queue === "object" ? nextRuntime.run.queue : {}),
      },
      uploads: Array.isArray(nextRuntime?.run?.uploads) ? nextRuntime.run.uploads : previous.run.uploads,
    },
    events: Array.isArray(nextRuntime?.events) ? nextRuntime.events.slice(-DEFAULT_RECENT_EVENT_LIMIT) : previous.events,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(runtimePath, merged);
  return merged;
};

export const readSoftuchiveControl = async (repoRoot) => {
  const { controlPath } = resolveSoftuchivePaths(repoRoot);
  const defaults = defaultSoftuchiveControl();
  const current = await readJsonFile(controlPath, defaults);
  const skipRequestedUploadSessionId = String(current?.skipRequestedUploadSessionId || "").trim();
  return {
    ...defaults,
    ...(current && typeof current === "object" ? current : {}),
    pauseRequested: current?.pauseRequested === true,
    uploadPaused: current?.uploadPaused === true,
    uploadThrottleMbps: normalizeUploadThrottleMbps(current?.uploadThrottleMbps),
    skipRequestedUploadSessionId,
    skipRequestedAt: skipRequestedUploadSessionId ? String(current?.skipRequestedAt || "") || null : null,
  };
};

export const writeSoftuchiveControl = async (repoRoot, nextControl) => {
  const { controlPath } = resolveSoftuchivePaths(repoRoot);
  const previous = await readSoftuchiveControl(repoRoot);
  const merged = {
    ...previous,
    ...(nextControl && typeof nextControl === "object" ? nextControl : {}),
    pauseRequested:
      Object.prototype.hasOwnProperty.call(nextControl || {}, "pauseRequested")
        ? nextControl?.pauseRequested === true
        : previous.pauseRequested === true,
    uploadPaused:
      Object.prototype.hasOwnProperty.call(nextControl || {}, "uploadPaused")
        ? nextControl?.uploadPaused === true
        : previous.uploadPaused === true,
    uploadThrottleMbps:
      Object.prototype.hasOwnProperty.call(nextControl || {}, "uploadThrottleMbps")
        ? normalizeUploadThrottleMbps(nextControl?.uploadThrottleMbps)
        : normalizeUploadThrottleMbps(previous.uploadThrottleMbps),
    skipRequestedUploadSessionId:
      Object.prototype.hasOwnProperty.call(nextControl || {}, "skipRequestedUploadSessionId")
        ? String(nextControl?.skipRequestedUploadSessionId || "").trim()
        : String(previous.skipRequestedUploadSessionId || "").trim(),
    skipRequestedAt:
      Object.prototype.hasOwnProperty.call(nextControl || {}, "skipRequestedAt")
        ? nextControl?.skipRequestedAt
          ? String(nextControl.skipRequestedAt)
          : null
        : previous.skipRequestedAt || null,
    updatedAt: new Date().toISOString(),
  };
  if (!merged.skipRequestedUploadSessionId) {
    merged.skipRequestedAt = null;
  }
  await writeJsonFile(controlPath, merged);
  return merged;
};

export const appendSoftuchiveSummary = async (repoRoot, lines) => {
  const { summaryLogPath } = resolveSoftuchivePaths(repoRoot);
  await ensureDirectory(path.dirname(summaryLogPath));
  const text = Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines || "");
  if (!text.trim()) return summaryLogPath;
  await fs.appendFile(summaryLogPath, `${text.trim()}\n\n`, "utf8");
  return summaryLogPath;
};
