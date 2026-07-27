const state = {
  latest: null,
  notice: {
    tone: "info",
    text: "Loading Softuchive status...",
  },
  settingsDirty: false,
  uploadControlDirty: false,
  pendingArchiveFolder: "",
  restartArmed: false,
  restartArmTimeout: null,
};

const elements = {
  noticeBanner: document.getElementById("notice-banner"),
  archiveNowButton: document.getElementById("archive-now-button"),
  pauseResumeButton: document.getElementById("pause-resume-button"),
  skipCurrentVodButton: document.getElementById("skip-current-vod-button"),
  restartButton: document.getElementById("restart-button"),
  autoPollToggle: document.getElementById("auto-poll-toggle"),
  pollIntervalInput: document.getElementById("poll-interval-input"),
  autoTaskDetail: document.getElementById("auto-task-detail"),
  obsCloseToggle: document.getElementById("obs-close-toggle"),
  obsRunningValue: document.getElementById("obs-running-value"),
  obsTriggerValue: document.getElementById("obs-trigger-value"),
  pickFolderButton: document.getElementById("pick-folder-button"),
  archiveFolderInput: document.getElementById("archive-folder-input"),
  saveSettingsButton: document.getElementById("save-settings-button"),
  uploadThrottleToggle: document.getElementById("upload-throttle-toggle"),
  uploadThrottleInput: document.getElementById("upload-throttle-input"),
  applyUploadControlButton: document.getElementById("apply-upload-control-button"),
  uploadControlDetail: document.getElementById("upload-control-detail"),
  viewArchiveFolderButton: document.getElementById("view-archive-folder-button"),
  viewLogsButton: document.getElementById("view-logs-button"),
  pollStateValue: document.getElementById("poll-state-value"),
  pollStageValue: document.getElementById("poll-stage-value"),
  lastPollValue: document.getElementById("last-poll-value"),
  lastPollDetailValue: document.getElementById("last-poll-detail-value"),
  queueValue: document.getElementById("queue-value"),
  queueDetailValue: document.getElementById("queue-detail-value"),
  currentTriggerPill: document.getElementById("current-trigger-pill"),
  currentItemValue: document.getElementById("current-item-value"),
  currentItemDetailValue: document.getElementById("current-item-detail-value"),
  progressValue: document.getElementById("progress-value"),
  progressDetailValue: document.getElementById("progress-detail-value"),
  etaValue: document.getElementById("eta-value"),
  etaDetailValue: document.getElementById("eta-detail-value"),
  progressFill: document.getElementById("progress-fill"),
  summaryBox: document.getElementById("summary-box"),
  uploadList: document.getElementById("upload-list"),
  eventList: document.getElementById("event-list"),
};

const clampPercent = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
};

const formatBytes = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = number;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatMbps = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0 Mbps";
  return `${number >= 10 ? number.toFixed(1) : number.toFixed(2)} Mbps`;
};

const formatDurationMs = (value) => {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Unknown";
  const totalSeconds = Math.max(1, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatTimestamp = (value) => {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
};

const formatRelativeTime = (value) => {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const deltaSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 10) return "Just now";
  if (abs < 60) return `${abs}s ${deltaSeconds >= 0 ? "ago" : "from now"}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${deltaSeconds >= 0 ? "ago" : "from now"}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${deltaSeconds >= 0 ? "ago" : "from now"}`;
  return `${Math.round(abs / 86400)}d ${deltaSeconds >= 0 ? "ago" : "from now"}`;
};

const createTextNode = (tagName, className, text) => {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.textContent = String(text ?? "");
  return node;
};

const currentArchiveFolderInput = () => String(elements.archiveFolderInput.value || state.pendingArchiveFolder || "").trim();

const computeSettingsDirty = (referenceSettings = state.latest?.settings || {}) => {
  const pollingIntervalMinutes = Math.max(1, Math.min(720, Math.floor(Number(elements.pollIntervalInput.value) || 15)));
  const savedPollingIntervalMinutes = Math.max(1, Math.min(720, Math.floor(Number(referenceSettings?.pollingIntervalMinutes) || 15)));
  const savedArchiveFolder = String(
    referenceSettings?.archiveFolder || state.latest?.runtime?.app?.archiveFolder || ""
  ).trim();

  return (
    pollingIntervalMinutes !== savedPollingIntervalMinutes ||
    elements.obsCloseToggle.checked !== (referenceSettings?.pollOnObsCloseEnabled === true) ||
    currentArchiveFolderInput() !== savedArchiveFolder
  );
};

const statusLabel = (run) => {
  const raw = String(run?.status || "idle").trim().toLowerCase();
  if (!raw) return "Idle";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

const setNotice = (tone, text) => {
  state.notice = {
    tone,
    text,
  };
  renderNotice();
};

const renderNotice = () => {
  elements.noticeBanner.dataset.tone = state.notice.tone || "info";
  elements.noticeBanner.textContent = state.notice.text || "";
};

const renderUploads = (uploads = []) => {
  const items = Array.isArray(uploads)
    ? [...uploads].sort((left, right) => {
        const leftActive = ["queued", "preparing", "uploading", "finalizing"].includes(String(left?.state || ""));
        const rightActive = ["queued", "preparing", "uploading", "finalizing"].includes(String(right?.state || ""));
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return Number(right?.updatedAtMs || 0) - Number(left?.updatedAtMs || 0);
      })
    : [];

  if (items.length === 0) {
    elements.uploadList.replaceChildren(createTextNode("div", "empty-state", "No uploads are queued right now."));
    return;
  }

  const cards = items.map((upload) => {
    const card = document.createElement("article");
    card.className = "upload-card";

    const stateText = String(upload?.state || "idle").replace(/-/g, " ");
    const percent = Number.isFinite(Number(upload?.percent)) ? `${Math.round(Number(upload.percent))}%` : "No progress yet";
    const uploadBytes =
      Number.isFinite(Number(upload?.uploadedBytes)) && Number.isFinite(Number(upload?.totalBytes))
        ? `${formatBytes(upload.uploadedBytes)} / ${formatBytes(upload.totalBytes)}`
        : "Waiting for byte data";
    const etaText = Number.isFinite(Number(upload?.estimatedRemainingMs))
      ? formatDurationMs(upload.estimatedRemainingMs)
      : "Estimating";
    const speedText =
      Number.isFinite(Number(upload?.uploadMbps)) && Number(upload.uploadMbps) > 0
        ? ` • ${formatMbps(upload.uploadMbps)}`
        : "";
    const throttleText =
      Number.isFinite(Number(upload?.uploadThrottleMbps)) && Number(upload.uploadThrottleMbps) > 0
        ? ` • Limit ${formatMbps(upload.uploadThrottleMbps)}`
        : "";
    const stallText = Number(upload?.stallAttempt) > 0 ? ` Stall recoveries: ${upload.stallAttempt}.` : "";

    card.append(
      createTextNode("strong", "", upload?.title || upload?.recordingName || "Queued archive part"),
      createTextNode(
        "span",
        "minor",
        `${upload?.recordingName || "No recording name"}${upload?.partNumber ? ` • Part ${upload.partNumber}` : ""}`
      ),
      createTextNode("span", "minor", `${upload?.message || "Queued for processing"}${stallText}`),
      createTextNode("span", "minor", `${percent} • ${uploadBytes} • ETA ${etaText}${speedText}${throttleText}`),
      createTextNode("span", "upload-state", stateText)
    );
    return card;
  });

  elements.uploadList.replaceChildren(...cards);
};

const renderEvents = (events = []) => {
  const items = Array.isArray(events) ? [...events].slice(-18).reverse() : [];
  if (items.length === 0) {
    elements.eventList.replaceChildren(createTextNode("div", "empty-state", "No pipeline events have been captured yet."));
    return;
  }

  const cards = items.map((event) => {
    const card = document.createElement("article");
    card.className = "event-card";
    const timestamp = createTextNode("time", "", formatTimestamp(event?.timestamp));
    if (event?.timestamp) timestamp.dateTime = String(event.timestamp);
    card.append(timestamp, createTextNode("span", "minor", event?.message || ""));
    return card;
  });
  elements.eventList.replaceChildren(...cards);
};

const renderSummary = (summary) => {
  if (!summary) {
    elements.summaryBox.textContent = "No archive summary yet.";
    return;
  }

  const archivedParts = Array.isArray(summary.archivedParts) ? summary.archivedParts : [];
  const skipped = Array.isArray(summary.skippedRecordings) ? summary.skippedRecordings : [];
  const notes = Array.isArray(summary.notes) ? summary.notes : [];
  const lines = [
    `${statusLabel(summary)} • ${summary.trigger || "unknown trigger"}`,
    `Started ${formatTimestamp(summary.startedAt)} • Completed ${formatTimestamp(summary.completedAt)}`,
    `Queued uploads: ${summary.queuedUploads || 0} • Archived parts: ${summary.archivedPartCount || 0}`,
    `Backfilled chats: ${summary.backfilledChatCount || 0} • Backfilled emotes: ${summary.backfilledEmoteCount || 0}`,
  ];
  if (summary.error) lines.push(`Error: ${summary.error}`);
  if (archivedParts.length > 0) {
    lines.push("");
    lines.push("Archived parts:");
    archivedParts.slice(-5).forEach((part) => {
      lines.push(`• Twitch ${part?.twitchVodId || "?"} part ${part?.partNumber || "?"} -> ${part?.youtubeVideoId || "pending"}`);
    });
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    skipped.slice(-5).forEach((item) => {
      lines.push(`• ${item?.recordingName || "unknown"}: ${item?.reason || "skipped"}`);
    });
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    notes.slice(-5).forEach((note) => {
      lines.push(`• ${note}`);
    });
  }

  elements.summaryBox.textContent = lines.join("\n");
};

const render = () => {
  const latest = state.latest;
  if (!latest?.ok) {
    setNotice("error", latest?.error || "Softuchive could not load the archive repo.");
    elements.pollStateValue.textContent = "Unavailable";
    elements.pollStageValue.textContent = latest?.error || "Repo not found.";
    return;
  }

  const run = latest.runtime?.run || {};
  const queue = run.queue || {};
  const current = run.current || null;
  const task = latest.task || {};
  const settings = latest.settings || {};
  const control = latest.control || {};
  const pauseRequested = latest.control?.pauseRequested === true;

  if (state.notice.text === "Loading Softuchive status...") {
    state.notice = {
      tone: run.active ? "success" : "info",
      text: run.active ? run.message || "An archive run is active." : "Softuchive is ready. The archive pipeline is standing by.",
    };
    renderNotice();
  }

  if (!state.settingsDirty) {
    elements.pollIntervalInput.value = String(settings.pollingIntervalMinutes || 15);
    elements.obsCloseToggle.checked = settings.pollOnObsCloseEnabled === true;
    state.pendingArchiveFolder = settings.archiveFolder || latest.runtime?.app?.archiveFolder || "";
  }
  if (!state.uploadControlDirty) {
    const throttleMbps = Number(control.uploadThrottleMbps);
    elements.uploadThrottleToggle.checked = Number.isFinite(throttleMbps) && throttleMbps > 0;
    elements.uploadThrottleInput.value = Number.isFinite(throttleMbps) && throttleMbps > 0 ? String(throttleMbps) : "5";
  }

  elements.autoPollToggle.checked = task.enabled === true;
  elements.autoTaskDetail.textContent = task.exists
    ? `Task state: ${task.state || "Unknown"} • Every ${settings.pollingIntervalMinutes || 15} minute(s).`
    : "Scheduled task is not installed yet. Enabling auto-polling will install it.";
  const archiveFolderValue = state.pendingArchiveFolder || latest.runtime?.app?.archiveFolder || "";
  if (elements.archiveFolderInput.value !== archiveFolderValue) {
    elements.archiveFolderInput.value = archiveFolderValue;
  }
  elements.archiveFolderInput.placeholder = "D:\\Stream Archives";

  elements.pollStateValue.textContent = `${statusLabel(run)}${run.active ? " • live" : ""}`;
  elements.pollStageValue.textContent = run.message || "Waiting for the next poll.";

  const lastPollAt = run.lastPollStartedAt || run.lastPollCompletedAt || null;
  elements.lastPollValue.textContent = formatRelativeTime(lastPollAt);
  elements.lastPollDetailValue.textContent = lastPollAt
    ? `${formatTimestamp(lastPollAt)} • ${String(run.lastPollStatus || run.status || "idle")}`
    : "No poll has started yet.";

  elements.queueValue.textContent = `${queue.remaining || 0} active / ${queue.total || 0} total`;
  elements.queueDetailValue.textContent =
    Number(queue.total || 0) > 0
      ? `${formatBytes(queue.remainingBytes || 0)} remaining • ETA ${formatDurationMs(queue.estimatedRemainingMs)}`
      : "No uploads are queued.";

  elements.currentTriggerPill.textContent = run.trigger || "idle";
  elements.currentItemValue.textContent = current?.title || current?.recordingName || "No active archive";
  elements.currentItemDetailValue.textContent = current?.message || run.message || "Waiting for the next poll.";

  const currentPercent = clampPercent(current?.percent);
  elements.progressValue.textContent = `${Math.round(currentPercent)}%`;
  elements.progressDetailValue.textContent =
    Number.isFinite(Number(current?.uploadedBytes)) && Number.isFinite(Number(current?.totalBytes))
      ? `${formatBytes(current.uploadedBytes)} / ${formatBytes(current.totalBytes)}`
      : "No upload byte data yet.";
  elements.progressFill.style.width = `${currentPercent}%`;
  elements.progressFill.parentElement?.setAttribute("aria-valuenow", String(Math.round(currentPercent)));

  elements.etaValue.textContent = formatDurationMs(current?.estimatedRemainingMs || queue.estimatedRemainingMs);
  elements.etaDetailValue.textContent =
    Number(queue.remaining || 0) > 1
      ? `${queue.remaining} uploads are still in the queue.`
      : Number(queue.remaining || 0) === 1
        ? "One upload is still in the queue."
        : "ETA appears while bytes are moving.";

  elements.obsRunningValue.textContent = latest.obsMonitor?.running ? "OBS is open" : "OBS is closed";
  elements.obsTriggerValue.textContent = latest.obsMonitor?.lastTriggeredAt
    ? `${formatRelativeTime(latest.obsMonitor.lastTriggeredAt)}`
    : "Never";

  elements.pauseResumeButton.textContent = pauseRequested || run.status === "paused" ? "Resume Archiving" : "Pause Current Archive";
  elements.pauseResumeButton.disabled = !run.active && !(pauseRequested || run.status === "paused");
  const currentSessionId = String(current?.sessionId || "").trim();
  const currentState = String(current?.state || "").toLowerCase();
  elements.skipCurrentVodButton.disabled =
    !run.active || !currentSessionId || ["done", "error", "paused", "skipped"].includes(currentState);
  elements.restartButton.textContent = state.restartArmed ? "Click Again to Confirm Restart" : "Restart Interrupted Archive";
  elements.restartButton.disabled = run.active && run.status !== "paused";
  elements.archiveNowButton.disabled = run.active;
  elements.saveSettingsButton.disabled = !state.settingsDirty;
  elements.applyUploadControlButton.disabled = !state.uploadControlDirty;
  const activeThrottleMbps = Number(control.uploadThrottleMbps);
  const hasThrottle = Number.isFinite(activeThrottleMbps) && activeThrottleMbps > 0;
  const currentUploadMbps = Number(current?.uploadMbps);
  elements.uploadControlDetail.textContent = hasThrottle
    ? `Limit active: ${formatMbps(activeThrottleMbps)}${
        Number.isFinite(currentUploadMbps) && currentUploadMbps > 0 ? ` • Current ${formatMbps(currentUploadMbps)}` : ""
      }.`
    : Number.isFinite(currentUploadMbps) && currentUploadMbps > 0
      ? `No limit active. Current upload speed: ${formatMbps(currentUploadMbps)}.`
      : "No upload speed limit is active.";

  renderUploads(run.uploads);
  renderEvents(latest.runtime?.events);
  renderSummary(run.summary);
};

const applyState = (payload) => {
  state.latest = payload;
  render();
};

const withBusyButton = async (button, action) => {
  const originalText = button.textContent;
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    render();
  }
};

const armRestart = () => {
  state.restartArmed = true;
  render();
  if (state.restartArmTimeout) window.clearTimeout(state.restartArmTimeout);
  state.restartArmTimeout = window.setTimeout(() => {
    state.restartArmed = false;
    render();
  }, 5000);
};

const bindEvents = () => {
  elements.pollIntervalInput.addEventListener("input", () => {
    state.settingsDirty = computeSettingsDirty();
    render();
  });

  elements.obsCloseToggle.addEventListener("change", () => {
    state.settingsDirty = computeSettingsDirty();
    render();
  });

  elements.archiveFolderInput.addEventListener("input", () => {
    state.pendingArchiveFolder = elements.archiveFolderInput.value;
    state.settingsDirty = computeSettingsDirty();
    render();
  });

  elements.uploadThrottleToggle.addEventListener("change", () => {
    state.uploadControlDirty = true;
    render();
  });

  elements.uploadThrottleInput.addEventListener("input", () => {
    state.uploadControlDirty = true;
    render();
  });

  elements.archiveNowButton.addEventListener("click", () =>
    withBusyButton(elements.archiveNowButton, async () => {
      const result = await window.softuchive.archiveNow();
      setNotice(result.ok ? "success" : "warning", result.message || "Archive action finished.");
    })
  );

  elements.pauseResumeButton.addEventListener("click", () =>
    withBusyButton(elements.pauseResumeButton, async () => {
      const latest = state.latest;
      const paused = latest?.control?.pauseRequested === true || latest?.runtime?.run?.status === "paused";
      const result = paused ? await window.softuchive.resumeArchive() : await window.softuchive.pauseArchive();
      setNotice(result.ok ? "success" : "warning", result.message || "Updated archive state.");
    })
  );

  elements.skipCurrentVodButton.addEventListener("click", () =>
    withBusyButton(elements.skipCurrentVodButton, async () => {
      const result = await window.softuchive.skipCurrentVod();
      setNotice(result.ok ? "success" : "warning", result.message || "Skip request finished.");
    })
  );

  elements.restartButton.addEventListener("click", () =>
    withBusyButton(elements.restartButton, async () => {
      if (!state.restartArmed) {
        armRestart();
        return;
      }
      state.restartArmed = false;
      const result = await window.softuchive.restartArchive();
      setNotice(result.ok ? "success" : "warning", result.message || "Restart action finished.");
    })
  );

  elements.autoPollToggle.addEventListener("change", async () => {
    const previousChecked = !elements.autoPollToggle.checked;
    elements.autoPollToggle.disabled = true;
    try {
      const intervalMinutes = Math.max(1, Math.min(720, Math.floor(Number(elements.pollIntervalInput.value) || 15)));
      const result = await window.softuchive.setAutoPolling({
        enabled: elements.autoPollToggle.checked,
        intervalMinutes,
      });
      if (!result.ok) {
        elements.autoPollToggle.checked = previousChecked;
      }
      setNotice(result.ok ? "success" : "warning", result.message || "Updated automatic polling.");
      if (result.ok) {
        state.settingsDirty = computeSettingsDirty(result.settings || state.latest?.settings || {});
      }
    } finally {
      elements.autoPollToggle.disabled = false;
      render();
    }
  });

  elements.pickFolderButton.addEventListener("click", async () => {
    const picked = await window.softuchive.pickArchiveFolder();
    if (!picked.ok || !picked.folder) return;
    state.pendingArchiveFolder = picked.folder;
    elements.archiveFolderInput.value = picked.folder;
    state.settingsDirty = computeSettingsDirty();
    render();
  });

  elements.saveSettingsButton.addEventListener("click", () =>
    withBusyButton(elements.saveSettingsButton, async () => {
      const payload = {
        pollingIntervalMinutes: Math.max(1, Math.min(720, Math.floor(Number(elements.pollIntervalInput.value) || 15))),
        pollOnObsCloseEnabled: elements.obsCloseToggle.checked,
        archiveFolder: currentArchiveFolderInput(),
      };
      const result = await window.softuchive.saveSettings(payload);
      if (result.ok) {
        state.pendingArchiveFolder = result.settings?.archiveFolder || payload.archiveFolder;
        elements.archiveFolderInput.value = state.pendingArchiveFolder;
        state.settingsDirty = computeSettingsDirty(result.settings || payload);
        setNotice("success", `Settings saved. Archive folder: ${state.pendingArchiveFolder}.`);
      } else {
        setNotice("error", result.message || "Failed to save settings.");
      }
    })
  );

  elements.applyUploadControlButton.addEventListener("click", () =>
    withBusyButton(elements.applyUploadControlButton, async () => {
      const result = await window.softuchive.setUploadControl({
        throttleEnabled: elements.uploadThrottleToggle.checked,
        uploadThrottleMbps: Math.max(0.01, Math.min(10000, Number(elements.uploadThrottleInput.value) || 0)),
      });
      if (result.ok) {
        state.uploadControlDirty = false;
      }
      setNotice(result.ok ? "success" : "warning", result.message || "Updated upload speed control.");
    })
  );

  elements.viewLogsButton.addEventListener("click", async () => {
    const result = await window.softuchive.openLogs();
    if (!result.ok) setNotice("warning", result.message || "Could not open the log path.");
  });

  elements.viewArchiveFolderButton.addEventListener("click", async () => {
    const result = await window.softuchive.openArchiveFolder();
    if (!result.ok) setNotice("warning", result.message || "Could not open the archive folder.");
  });
};

const startClockRefresh = () => {
  window.setInterval(() => {
    if (!state.latest) return;
    render();
  }, 1000);
};

const bootstrap = async () => {
  bindEvents();
  renderNotice();
  startClockRefresh();
  const initialState = await window.softuchive.getState();
  applyState(initialState);
  window.softuchive.onState((payload) => {
    applyState(payload);
  });
};

bootstrap().catch((error) => {
  setNotice("error", error?.message || "Softuchive failed to start.");
});
