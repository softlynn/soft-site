const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const dotenv = require("dotenv");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const APP_NAME = "Softuchive";
const APP_ID = "one.softu.softuchive";
const TASK_NAME = "SoftArchivePipeline";
const WINDOWS_DEFAULT_ARCHIVE_FOLDER = "D:\\Stream Archives";
const DEFAULT_ARCHIVE_FOLDER = "recordings";
const STATE_POLL_INTERVAL_MS = 1500;
const OBS_POLL_INTERVAL_MS = 5000;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let pipelineChild = null;
let repoRoot = null;
let softuchiveStateModulePromise = null;
let statePollHandle = null;
let obsPollHandle = null;
let lastBroadcastKey = "";
let obsPollInFlight = false;
let obsMonitorState = {
  running: false,
  lastCheckedAt: null,
  lastClosedAt: null,
  lastTriggeredAt: null,
};
let repoEnvironmentLoadedFor = "";

const pipelineStatePath = () => path.join(repoRoot, "scripts", ".state", "pipeline-state.json");
const pipelineRunLockPath = () => path.join(repoRoot, "scripts", ".state", "pipeline-run.lock.json");
const iconAssetPath = () => path.join(__dirname, "assets", "icon.png");

const psQuote = (value) => `'${String(value || "").replace(/'/g, "''")}'`;

const fileExists = (targetPath) => {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolvePortableExecutableDirectory = () => {
  const explicitDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (explicitDir) return explicitDir;

  const explicitFile = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (explicitFile) return path.dirname(explicitFile);

  return "";
};

const ensureRepoEnvironmentLoaded = () => {
  const root = resolveRepoRoot();
  if (repoEnvironmentLoadedFor === root) return;
  const envPath = path.join(root, ".env.local");
  if (fileExists(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
  repoEnvironmentLoadedFor = root;
};

const looksLikeSoftSiteRepo = (candidate) =>
  Boolean(candidate) &&
  fileExists(path.join(candidate, ".git")) &&
  fileExists(path.join(candidate, "scripts", "run_local_archive_pipeline.mjs"));

const findRepoRootFrom = (startPath) => {
  if (!startPath) return null;
  let current = path.resolve(startPath);
  while (true) {
    if (looksLikeSoftSiteRepo(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const resolveRepoRoot = () => {
  if (repoRoot) return repoRoot;

  const candidates = [
    process.env.SOFTUCHIVE_REPO_ROOT || "",
    resolvePortableExecutableDirectory(),
    process.cwd(),
    path.dirname(process.argv[0] || ""),
    path.dirname(process.execPath),
    process.resourcesPath || "",
    path.resolve(__dirname, "..", ".."),
    app ? app.getAppPath() : "",
    path.join(os.homedir(), "soft-site"),
    path.join(os.homedir(), "Documents", "soft-site"),
  ];

  for (const candidate of candidates) {
    const resolved = findRepoRootFrom(candidate);
    if (resolved) {
      repoRoot = resolved;
      return repoRoot;
    }
  }

  throw new Error(
    "Could not locate the soft-site repository root. Keep the portable exe inside the soft-site folder tree, or set SOFTUCHIVE_REPO_ROOT."
  );
};

const readJsonFile = async (targetPath, fallback) => {
  try {
    const raw = await fsPromises.readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (targetPath, payload) => {
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const runPowerShell = (command, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
  });

const getSoftuchiveStateModule = async () => {
  if (softuchiveStateModulePromise) return softuchiveStateModulePromise;
  const root = resolveRepoRoot();
  const modulePath = pathToFileURL(path.join(root, "scripts", "softuchive_state.mjs")).href;
  softuchiveStateModulePromise = import(modulePath);
  return softuchiveStateModulePromise;
};

const getArchiveFolderFallback = () => {
  ensureRepoEnvironmentLoaded();
  const configured = String(process.env.LOCAL_RECORDINGS_DIR || "").trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(resolveRepoRoot(), configured);
  }
  if (process.platform === "win32") return WINDOWS_DEFAULT_ARCHIVE_FOLDER;
  return path.join(resolveRepoRoot(), DEFAULT_ARCHIVE_FOLDER);
};

const normalizeArchiveFolder = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return getArchiveFolderFallback();
  return path.isAbsolute(raw) ? raw : path.resolve(resolveRepoRoot(), raw);
};

const ensureStateFiles = async () => {
  const stateModule = await getSoftuchiveStateModule();
  return stateModule.ensureSoftuchiveStateFiles(resolveRepoRoot(), {
    archiveFolder: getArchiveFolderFallback(),
  });
};

const getScheduledTaskStatus = async () => {
  const raw = await runPowerShell(`
    try {
      $task = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction Stop
      [pscustomobject]@{
        exists = $true
        enabled = ([string]$task.State -ne 'Disabled')
        state = [string]$task.State
      } | ConvertTo-Json -Compress
    } catch {
      [pscustomobject]@{
        exists = $false
        enabled = $false
        state = 'NotInstalled'
      } | ConvertTo-Json -Compress
    }
  `);

  try {
    return JSON.parse(raw);
  } catch {
    return {
      exists: false,
      enabled: false,
      state: "Unknown",
    };
  }
};

const setScheduledTaskEnabled = async (enabled, intervalMinutes) => {
  const safeMinutes = Math.max(1, Math.min(720, Math.floor(Number(intervalMinutes) || 15)));
  const installScript = path.join(resolveRepoRoot(), "scripts", "install_local_archive_task.ps1");

  if (enabled) {
    await runPowerShell(`& ${psQuote(installScript)} -TaskName ${psQuote(TASK_NAME)} -EveryMinutes ${safeMinutes}`, 30000);
  } else {
    await runPowerShell(
      `
      $task = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue
      if ($task) {
        Disable-ScheduledTask -TaskName ${psQuote(TASK_NAME)} | Out-Null
      }
      `,
      15000
    );
  }

  return getScheduledTaskStatus();
};

const isObsRunning = async () => {
  const raw = await runPowerShell(
    `
    $processes = @(Get-Process obs64,obs32 -ErrorAction SilentlyContinue)
    [pscustomobject]@{
      running = ($processes.Count -gt 0)
    } | ConvertTo-Json -Compress
    `,
    8000
  );

  try {
    return JSON.parse(raw)?.running === true;
  } catch {
    return false;
  }
};

const buildAppState = async () => {
  try {
    const stateModule = await getSoftuchiveStateModule();
    await ensureStateFiles();
    const settings = await stateModule.readSoftuchiveSettings(resolveRepoRoot(), {
      archiveFolder: getArchiveFolderFallback(),
    });
    const runtime = await stateModule.readSoftuchiveRuntime(resolveRepoRoot(), {
      archiveFolder: settings.archiveFolder || getArchiveFolderFallback(),
    });
    const control = await stateModule.readSoftuchiveControl(resolveRepoRoot());
    const task = await getScheduledTaskStatus();

    return {
      ok: true,
      app: {
        name: APP_NAME,
        repoRoot: resolveRepoRoot(),
        taskName: TASK_NAME,
      },
      settings,
      runtime,
      control,
      task,
      pipelineChildActive: Boolean(pipelineChild && pipelineChild.exitCode == null),
      obsMonitor: {
        ...obsMonitorState,
        enabled: settings.pollOnObsCloseEnabled === true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      app: {
        name: APP_NAME,
      },
      obsMonitor: obsMonitorState,
    };
  }
};

const broadcastState = async (force = false) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = await buildAppState();
  const nextKey = JSON.stringify(state);
  if (!force && nextKey === lastBroadcastKey) return;
  lastBroadcastKey = nextKey;
  mainWindow.webContents.send("softuchive:state", state);
};

const spawnPipeline = async (trigger) => {
  const scriptPath = path.join(resolveRepoRoot(), "scripts", "run_local_archive_pipeline.mjs");
  const child = spawn(process.execPath, [scriptPath, `--trigger=${trigger}`], {
    cwd: resolveRepoRoot(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    windowsHide: true,
    stdio: "ignore",
  });

  pipelineChild = child;
  child.once("exit", async () => {
    pipelineChild = null;
    await broadcastState(true);
  });
  child.once("error", async () => {
    pipelineChild = null;
    await broadcastState(true);
  });

  await broadcastState(true);
};

const launchPipelineRun = async (trigger) => {
  const state = await buildAppState();
  if (!state.ok) return { ok: false, message: state.error || "Softuchive could not find the repo root." };
  if (state.control?.pauseRequested && trigger !== "resume") {
    return { ok: false, message: "Archiving is paused. Resume it before starting another poll." };
  }
  if (state.runtime?.run?.active) {
    return {
      ok: false,
      message: `A poll is already running (${state.runtime.run?.stage || "working"}).`,
    };
  }

  await spawnPipeline(trigger);
  return {
    ok: true,
    message: trigger === "obs-close" ? "Started archive poll because OBS closed." : "Started archive poll.",
  };
};

const openExistingPath = async (targetPath, fallbackDirectory = "") => {
  const preferredPath = targetPath && fileExists(targetPath) ? targetPath : fallbackDirectory;
  if (!preferredPath) {
    return { ok: false, message: "Nothing to open yet." };
  }
  await shell.openPath(preferredPath);
  return { ok: true };
};

const restartInterruptedArchive = async () => {
  const state = await buildAppState();
  if (!state.ok) return { ok: false, message: state.error || "Could not inspect archive state." };
  if (state.runtime?.run?.active) {
    return { ok: false, message: "An archive is still running. Pause or wait for it before forcing a restart." };
  }

  const currentState = await readJsonFile(pipelineStatePath(), {
    processedFiles: {},
    processedVodIds: {},
  });
  const processedFiles = currentState?.processedFiles && typeof currentState.processedFiles === "object" ? currentState.processedFiles : {};
  let cleared = 0;

  for (const [filePath, entry] of Object.entries(processedFiles)) {
    const status = String(entry?.status || "").toLowerCase();
    if (!["processing", "paused"].includes(status)) continue;
    delete processedFiles[filePath];
    cleared += 1;
  }

  currentState.processedFiles = processedFiles;
  await writeJsonFile(pipelineStatePath(), currentState);

  const stateModule = await getSoftuchiveStateModule();
  await stateModule.writeSoftuchiveControl(resolveRepoRoot(), { pauseRequested: false });
  const result = await launchPipelineRun("restart");
  if (!result.ok) return result;

  return {
    ok: true,
    message: cleared > 0 ? `Cleared ${cleared} interrupted archive marker(s) and restarted polling.` : "Restarted polling.",
  };
};

const isProcessRunning = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminateProcess = async (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0 || numericPid === process.pid) return false;
  if (!isProcessRunning(numericPid)) return false;

  if (process.platform === "win32") {
    await runPowerShell(`Stop-Process -Id ${numericPid} -Force -ErrorAction SilentlyContinue`, 10000).catch(() => "");
  } else {
    try {
      process.kill(numericPid, "SIGTERM");
    } catch {}
  }
  return true;
};

const findCurrentSkippableUpload = (run) => {
  const terminalStates = new Set(["done", "error", "paused", "skipped"]);
  const current = run?.current && typeof run.current === "object" ? run.current : null;
  if (current?.sessionId && !terminalStates.has(String(current.state || "").toLowerCase())) return current;
  const uploads = Array.isArray(run?.uploads) ? run.uploads : [];
  return (
    uploads.find((upload) => upload?.sessionId && !terminalStates.has(String(upload?.state || "").toLowerCase())) ||
    null
  );
};

const markSkippedUploadAndRestart = async (upload) => {
  const sessionId = String(upload?.sessionId || "").trim();
  if (!sessionId) return { ok: false, message: "No current VOD is available to skip yet." };

  const currentState = await readJsonFile(pipelineStatePath(), {
    processedFiles: {},
    processedVodIds: {},
  });
  const processedFiles =
    currentState?.processedFiles && typeof currentState.processedFiles === "object" ? currentState.processedFiles : {};
  let matchedPath = "";
  let matchedEntry = null;

  for (const [filePath, entry] of Object.entries(processedFiles)) {
    if (String(entry?.uploadSessionId || "").trim() !== sessionId) continue;
    matchedPath = filePath;
    matchedEntry = entry && typeof entry === "object" ? entry : {};
    break;
  }

  const ownerPid = Number(matchedEntry?.ownerPid || 0);
  const killed = await terminateProcess(ownerPid);
  await fsPromises.rm(pipelineRunLockPath(), { force: true }).catch(() => {});

  const nowIso = new Date().toISOString();
  if (matchedPath) {
    processedFiles[matchedPath] = {
      ...matchedEntry,
      status: "skipped_manual",
      twitchVodId: upload?.twitchVodId ? String(upload.twitchVodId) : matchedEntry?.twitchVodId,
      part: Number.isFinite(Number(upload?.partNumber)) ? Math.max(1, Math.floor(Number(upload.partNumber))) : matchedEntry?.part,
      updatedAt: nowIso,
      skippedAt: nowIso,
      reason: "Manually skipped in Softuchive.",
    };
    currentState.processedFiles = processedFiles;
    await writeJsonFile(pipelineStatePath(), currentState);
  }

  const stateModule = await getSoftuchiveStateModule();
  await stateModule.writeSoftuchiveControl(resolveRepoRoot(), {
    skipRequestedUploadSessionId: "",
    skipRequestedAt: null,
  });

  const runtime = await stateModule.readSoftuchiveRuntime(resolveRepoRoot(), {
    archiveFolder: getArchiveFolderFallback(),
  });
  const uploads = Array.isArray(runtime.run?.uploads) ? runtime.run.uploads : [];
  const nextUploads = uploads.map((item) =>
    String(item?.sessionId || "").trim() === sessionId
      ? {
          ...item,
          state: "skipped",
          message: "VOD skipped from Softuchive",
          updatedAtMs: Date.now(),
        }
      : item
  );

  await stateModule.writeSoftuchiveRuntime(
    resolveRepoRoot(),
    {
      ...runtime,
      run: {
        ...(runtime.run || {}),
        active: false,
        status: "skipped",
        stage: "idle",
        message: "Current VOD skipped. Restarting archive poll for the next queued VOD.",
        completedAt: nowIso,
        lastPollCompletedAt: nowIso,
        lastPollStatus: "skipped",
        current: {
          ...(runtime.run?.current || {}),
          ...upload,
          state: "skipped",
          message: "VOD skipped from Softuchive",
        },
        uploads: nextUploads,
      },
    },
    {
      archiveFolder: runtime.app?.archiveFolder || getArchiveFolderFallback(),
    }
  );

  const result = await launchPipelineRun("skip-current-vod");
  return {
    ok: result.ok,
    message: result.ok
      ? `${killed ? "Stopped" : "Marked"} ${upload?.recordingName || upload?.title || "the current VOD"} as skipped and started the next poll.`
      : result.message,
  };
};

const updateSettings = async (partialSettings) => {
  const stateModule = await getSoftuchiveStateModule();
  const normalizedArchiveFolder = normalizeArchiveFolder(partialSettings?.archiveFolder);
  await fsPromises.mkdir(normalizedArchiveFolder, { recursive: true });
  const nextSettings = await stateModule.writeSoftuchiveSettings(
    resolveRepoRoot(),
    {
      ...(partialSettings && typeof partialSettings === "object" ? partialSettings : {}),
      archiveFolder: normalizedArchiveFolder,
    },
    {
      archiveFolder: getArchiveFolderFallback(),
    }
  );

  const runtime = await stateModule.readSoftuchiveRuntime(resolveRepoRoot(), {
    archiveFolder: nextSettings.archiveFolder || getArchiveFolderFallback(),
  });
  await stateModule.writeSoftuchiveRuntime(
    resolveRepoRoot(),
    {
      ...runtime,
      app: {
        ...(runtime.app || {}),
        archiveFolder: nextSettings.archiveFolder,
      },
    },
    {
      archiveFolder: nextSettings.archiveFolder || getArchiveFolderFallback(),
    }
  );

  const task = await getScheduledTaskStatus();
  if (task.enabled && Number.isFinite(Number(nextSettings.pollingIntervalMinutes))) {
    await setScheduledTaskEnabled(true, nextSettings.pollingIntervalMinutes);
  }

  await broadcastState(true);
  return { ok: true, settings: nextSettings };
};

const tickObsMonitor = async () => {
  if (obsPollInFlight) return;
  obsPollInFlight = true;
  try {
    const state = await buildAppState();
    const obsRunning = await isObsRunning();
    const previousRunning = obsMonitorState.running;

    obsMonitorState = {
      ...obsMonitorState,
      running: obsRunning,
      lastCheckedAt: new Date().toISOString(),
    };

    if (
      state.ok &&
      state.settings?.pollOnObsCloseEnabled === true &&
      previousRunning &&
      !obsRunning &&
      !state.runtime?.run?.active &&
      !state.control?.pauseRequested
    ) {
      obsMonitorState.lastClosedAt = new Date().toISOString();
      const result = await launchPipelineRun("obs-close");
      if (result.ok) {
        obsMonitorState.lastTriggeredAt = new Date().toISOString();
      }
    }

    await broadcastState();
  } finally {
    obsPollInFlight = false;
  }
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 680,
    backgroundColor: "#0c0b0a",
    icon: iconAssetPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.once("did-finish-load", async () => {
    await broadcastState(true);
  });
};

ipcMain.handle("softuchive:get-state", async () => buildAppState());

ipcMain.handle("softuchive:archive-now", async () => {
  const result = await launchPipelineRun("manual");
  await broadcastState(true);
  return result;
});

ipcMain.handle("softuchive:pause", async () => {
  const stateModule = await getSoftuchiveStateModule();
  await stateModule.writeSoftuchiveControl(resolveRepoRoot(), { pauseRequested: true });
  await broadcastState(true);
  return {
    ok: true,
    message: "Pause requested. The current stage will stop at the next safe point.",
  };
});

ipcMain.handle("softuchive:resume", async () => {
  const stateModule = await getSoftuchiveStateModule();
  await stateModule.writeSoftuchiveControl(resolveRepoRoot(), { pauseRequested: false });
  const result = await launchPipelineRun("resume");
  await broadcastState(true);
  return result.ok ? { ok: true, message: "Resumed archiving." } : result;
});

ipcMain.handle("softuchive:skip-current-vod", async () => {
  try {
    const state = await buildAppState();
    if (!state.ok) return { ok: false, message: state.error || "Could not inspect archive state." };
    if (!state.runtime?.run?.active) return { ok: false, message: "No archive run is active." };

    const upload = findCurrentSkippableUpload(state.runtime.run);
    const sessionId = String(upload?.sessionId || "").trim();
    if (!sessionId) return { ok: false, message: "No current VOD is available to skip yet." };

    const stateModule = await getSoftuchiveStateModule();
    await stateModule.writeSoftuchiveControl(resolveRepoRoot(), {
      skipRequestedUploadSessionId: sessionId,
      skipRequestedAt: new Date().toISOString(),
    });
    const fallbackResult = await markSkippedUploadAndRestart(upload);
    await broadcastState(true);
    return fallbackResult.ok
      ? fallbackResult
      : {
          ok: true,
          message: `Skip requested for ${upload?.recordingName || upload?.title || "the current VOD"}.`,
        };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Failed to request VOD skip.",
    };
  }
});

ipcMain.handle("softuchive:restart", async () => {
  const result = await restartInterruptedArchive();
  await broadcastState(true);
  return result;
});

ipcMain.handle("softuchive:set-upload-control", async (_event, payload) => {
  try {
    const throttleEnabled = payload?.throttleEnabled === true;
    const parsedMbps = Number(payload?.uploadThrottleMbps);
    const uploadThrottleMbps =
      throttleEnabled && Number.isFinite(parsedMbps) && parsedMbps > 0
        ? Math.max(0.01, Math.min(10000, Math.round(parsedMbps * 100) / 100))
        : null;
    const stateModule = await getSoftuchiveStateModule();
    const control = await stateModule.writeSoftuchiveControl(resolveRepoRoot(), {
      uploadPaused: payload?.uploadPaused === true,
      uploadThrottleMbps,
    });
    await broadcastState(true);
    return {
      ok: true,
      control,
      message: uploadThrottleMbps ? `Upload speed limit set to ${uploadThrottleMbps} Mbps.` : "Upload speed limit disabled.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Failed to update upload speed control.",
    };
  }
});

ipcMain.handle("softuchive:set-auto-polling", async (_event, payload) => {
  try {
    const enabled = payload?.enabled === true;
    const intervalMinutes = Math.max(1, Math.min(720, Math.floor(Number(payload?.intervalMinutes) || 15)));
    const settingsResult = await updateSettings({ pollingIntervalMinutes: intervalMinutes });
    if (!settingsResult?.ok) return settingsResult;
    const task = await setScheduledTaskEnabled(enabled, intervalMinutes);
    await broadcastState(true);
    return {
      ok: true,
      task,
      settings: settingsResult.settings,
      message: enabled
        ? `Automatic archiving is enabled every ${intervalMinutes} minute(s).`
        : "Automatic archiving is paused.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Failed to update automatic polling.",
    };
  }
});

ipcMain.handle("softuchive:save-settings", async (_event, payload) => {
  try {
    const nextSettings = {
      pollingIntervalMinutes: Math.max(1, Math.min(720, Math.floor(Number(payload?.pollingIntervalMinutes) || 15))),
      pollOnObsCloseEnabled: payload?.pollOnObsCloseEnabled === true,
      archiveFolder: String(payload?.archiveFolder || "").trim() || getArchiveFolderFallback(),
    };
    return await updateSettings(nextSettings);
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Failed to save settings.",
    };
  }
});

ipcMain.handle("softuchive:pick-archive-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose Archive Folder",
  });
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return { ok: false };
  }
  return { ok: true, folder: result.filePaths[0] };
});

ipcMain.handle("softuchive:open-logs", async () => {
  const state = await buildAppState();
  if (!state.ok) return { ok: false, message: state.error };
  const summaryLogPath = state.runtime?.app?.summaryLogPath || "";
  const stateDir = summaryLogPath ? path.dirname(summaryLogPath) : path.join(resolveRepoRoot(), "scripts", ".state");
  return openExistingPath(summaryLogPath, stateDir);
});

ipcMain.handle("softuchive:open-archive-folder", async () => {
  const state = await buildAppState();
  if (!state.ok) return { ok: false, message: state.error };
  const archiveFolder = state.settings?.archiveFolder || state.runtime?.app?.archiveFolder || getArchiveFolderFallback();
  await fsPromises.mkdir(archiveFolder, { recursive: true });
  return openExistingPath(archiveFolder, archiveFolder);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);
    await createWindow();
    statePollHandle = setInterval(() => {
      void broadcastState();
    }, STATE_POLL_INTERVAL_MS);
    obsPollHandle = setInterval(() => {
      void tickObsMonitor();
    }, OBS_POLL_INTERVAL_MS);
    void tickObsMonitor();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (statePollHandle) clearInterval(statePollHandle);
  if (obsPollHandle) clearInterval(obsPollHandle);
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
