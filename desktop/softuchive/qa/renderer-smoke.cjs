// Run with Electron, not Node. No production controller, scheduler, or pipeline is loaded.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
const appDirectory = process.env.SOFTUCHIVE_APP_DIR || path.join(__dirname, '..');
const calls = { pause: 0, resume: 0, skip: 0, restart: 0, openLogs: 0, openFolder: 0 };
let window;
const publish = () => window.webContents.send('softuchive:state', snapshot);

const snapshot = {
  ok: true, settings: { archiveFolder: 'D:\\Stream Archives', pollingIntervalMinutes: 15, pollOnObsCloseEnabled: true },
  runtime: { app: {}, run: { active: false, status: 'idle', uploads: [], queue: {} }, events: [] },
  control: {}, task: { exists: true, enabled: true, state: 'Ready' },
  obsMonitor: { enabled: false, running: false, lastCheckedAt: new Date().toISOString() },
};
ipcMain.handle('softuchive:get-state', () => snapshot);
ipcMain.handle('softuchive:save-settings', (_event, payload) => {
  snapshot.settings = { ...snapshot.settings, ...payload };
  return { ok: true, settings: snapshot.settings };
});
ipcMain.handle('softuchive:archive-now', async () => { throw new Error('Simulated archive failure'); });
ipcMain.handle('softuchive:open-admin', () => ({ ok: true, message: 'Local admin opened.' }));
ipcMain.handle('softuchive:pause', () => {
  calls.pause++;
  snapshot.control.pauseRequested = true;
  snapshot.runtime.run = { ...snapshot.runtime.run, active: false, status: 'paused', message: 'Archive paused.' };
  publish();
  return { ok: true, message: 'Archive paused.' };
});
ipcMain.handle('softuchive:resume', () => {
  calls.resume++;
  snapshot.control.pauseRequested = false;
  snapshot.runtime.run = { ...snapshot.runtime.run, active: true, status: 'running', message: 'Uploading the next recording.' };
  publish();
  return { ok: true, message: 'Archive resumed.' };
});
ipcMain.handle('softuchive:skip-current-vod', () => {
  calls.skip++;
  snapshot.control.skipRequestedUploadSessionId = snapshot.runtime.run.current.sessionId;
  publish();
  return { ok: true, message: 'Skip requested.' };
});
ipcMain.handle('softuchive:restart', () => { calls.restart++; return { ok: true }; });
ipcMain.handle('softuchive:set-upload-control', (_event, payload) => {
  calls.uploadControl = payload;
  snapshot.control.uploadThrottleMbps = payload.throttleEnabled ? payload.uploadThrottleMbps : 0;
  return { ok: true, control: snapshot.control };
});
ipcMain.handle('softuchive:set-auto-polling', (_event, payload) => {
  calls.schedule = payload;
  snapshot.task.enabled = payload.enabled;
  snapshot.settings.pollingIntervalMinutes = payload.intervalMinutes;
  return { ok: true, task: snapshot.task, settings: snapshot.settings };
});
ipcMain.handle('softuchive:pick-archive-folder', () => ({ ok: true, folder: 'E:\\Recordings' }));
ipcMain.handle('softuchive:open-logs', () => { calls.openLogs++; return { ok: true }; });
ipcMain.handle('softuchive:open-archive-folder', () => { calls.openFolder++; return { ok: true }; });

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 860, height: 650, show: false, webPreferences: {
    preload: path.join(appDirectory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
  } });
  try {
    await window.loadFile(path.join(appDirectory, 'renderer', 'index.html'));
    const evaluate = (script) => window.webContents.executeJavaScript(script);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    const destination = process.env.SOFTUCHIVE_SCREENSHOT_DIR;
    const capture = async (name) => {
      if (!destination) return;
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    for (let i = 0; i < 40 && !(await evaluate('Boolean(state.latest)')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await evaluate('state.latest.ok'), true);
    assert.equal(await evaluate('document.querySelectorAll(".section-block:not([hidden])").length'), 1);
    assert.equal(await evaluate('elements.uploadList.closest(".section-block").hidden'), false, 'Queue must be visible on the initial uploads screen.');
    assert.equal(await evaluate('elements.obsRunningValue.textContent'), 'Off', 'A disabled monitor must not look like an active OBS check.');
    assert.equal(await evaluate('elements.currentTransfer.hidden'), true, 'Idle state must not imply a transfer is running.');
    assert.equal(await evaluate('elements.runActions.hidden'), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await settle();
    await capture('idle');
    await evaluate('window.location.hash = "automation"');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await evaluate('document.getElementById("automation").hidden'), false);
    await evaluate('elements.pollIntervalInput.value = "27"; elements.pollIntervalInput.dispatchEvent(new Event("input"));');
    assert.equal(await evaluate('state.settingsDirty'), true);
    assert.equal(await evaluate('elements.saveSettingsButton.disabled'), false);
    await evaluate('applyState(state.latest)');
    assert.equal(await evaluate('elements.pollIntervalInput.value'), '27');
    await capture('settings');
    await evaluate('elements.saveSettingsButton.click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(snapshot.settings.archiveFolder, 'D:\\Stream Archives');
    assert.equal(snapshot.settings.pollingIntervalMinutes, 27);
    assert.equal(await evaluate('state.settingsDirty'), false);
    assert.equal(await evaluate('elements.pollIntervalInput.value'), '27');
    await evaluate('elements.uploadThrottleToggle.click(); elements.uploadThrottleInput.value = "8.5"; elements.uploadThrottleInput.dispatchEvent(new Event("input")); elements.applyUploadControlButton.click();');
    await settle();
    assert.deepEqual(calls.uploadControl, { throttleEnabled: true, uploadThrottleMbps: 8.5 });
    assert.equal(await evaluate('state.uploadControlDirty'), false);
    await evaluate('elements.autoPollToggle.click()');
    await settle();
    assert.deepEqual(calls.schedule, { enabled: false, intervalMinutes: 27 });
    await evaluate('elements.pickFolderButton.click()');
    await settle();
    assert.equal(await evaluate('elements.archiveFolderInput.value'), 'E:\\Recordings');
    assert.equal(await evaluate('state.settingsDirty'), true);
    await evaluate('elements.saveSettingsButton.click()');
    await settle();
    assert.equal(snapshot.settings.archiveFolder, 'E:\\Recordings');
    await evaluate('elements.archiveNowButton.click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(await evaluate('elements.noticeBanner.textContent'), /Simulated archive failure/);
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), false);
    snapshot.runtime.run = {
      active: true, status: 'running', stage: 'uploading', message: 'Backing up your finished recordings.', lastPollStartedAt: new Date().toISOString(), current: { sessionId: 'test', title: 'Saturday night · a very long stream title to check wrapping and small windows', state: 'uploading', percent: 42, uploadedBytes: 420000000, totalBytes: 1000000000, uploadMbps: 8.2, estimatedRemainingMs: 180000 },
      uploads: [{ sessionId: 'test', title: 'Saturday night', recordingName: '2026-09-29 18-30-00.mkv', partNumber: 1, state: 'uploading', percent: 42, uploadedBytes: 420000000, totalBytes: 1000000000 }, { sessionId: 'next', title: 'One more game before bed', partNumber: 2, state: 'queued' }], queue: { total: 3, remaining: 2, remainingBytes: 1420000000 },
    };
    snapshot.runtime.events = [{ timestamp: new Date().toISOString(), message: 'Found two finished recordings.' }, { timestamp: new Date().toISOString(), message: 'Uploading Saturday night.' }];
    window.webContents.send('softuchive:state', snapshot);
    await evaluate('setNotice("info", ""); window.location.hash = "overview"');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), true);
    assert.equal(await evaluate('elements.pauseResumeButton.disabled'), false);
    assert.equal(await evaluate('elements.progressFill.parentElement.getAttribute("aria-valuenow")'), '42');
    assert.equal(await evaluate('elements.currentTransfer.hidden'), false);
    assert.equal(await evaluate('elements.uploadList.children.length'), 2);
    assert.equal(await evaluate('(() => { const first = elements.uploadList.firstChild; render(); return first === elements.uploadList.firstChild; })()'), true);
    await capture('uploading');
    await evaluate('applyState({ ...state.latest, runtime: { ...state.latest.runtime, run: { ...state.latest.runtime.run, current: { ...state.latest.runtime.run.current, percent: null } } } })');
    assert.equal(await evaluate('elements.progressFill.parentElement.hasAttribute("aria-valuenow")'), false, 'Missing progress must be indeterminate, not a false zero percent.');
    publish();
    await settle();
    await evaluate('elements.pauseResumeButton.click()');
    await settle();
    assert.equal(calls.pause, 1);
    assert.equal(await evaluate('elements.pauseResumeButton.textContent'), 'Resume');
    assert.equal(await evaluate('elements.pauseResumeButton.disabled'), false);
    assert.equal(await evaluate('elements.runActions.hidden'), false);
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), true);
    assert.doesNotMatch(await evaluate('elements.etaDetailValue.textContent'), /8\.20 Mbps/, 'A paused transfer must not show the last observed rate as live.');
    assert.match(await evaluate('elements.uploadList.textContent'), /paused/i);
    await capture('paused');
    await evaluate('elements.pauseResumeButton.click()');
    await settle();
    assert.equal(calls.resume, 1);
    assert.equal(await evaluate('elements.pauseResumeButton.textContent'), 'Pause');
    await evaluate('elements.skipCurrentVodButton.click()');
    await settle();
    assert.equal(calls.skip, 1);
    assert.equal(await evaluate('elements.skipCurrentVodButton.disabled'), true);
    window.setSize(640, 520);
    await evaluate('setNotice("info", "")');
    await settle();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await capture('uploading-small');
    await evaluate('window.location.hash = "automation"');
    await settle();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await capture('settings-small');
    window.setSize(860, 650);
    snapshot.runtime.run = { ...snapshot.runtime.run, active: false, status: 'error', message: 'The upload connection was interrupted. Check the logs before restarting.', current: { ...snapshot.runtime.run.current, state: 'error' } };
    publish();
    await evaluate('window.location.hash = "overview"');
    await settle();
    assert.equal(await evaluate('elements.pollStateValue.textContent'), 'Needs attention');
    assert.equal(await evaluate('elements.pauseResumeButton.disabled'), true);
    assert.doesNotMatch(await evaluate('elements.etaValue.textContent'), /remaining/, 'An interrupted upload must not promise a running ETA.');
    assert.match(await evaluate('elements.uploadList.textContent'), /error/i);
    await capture('error');
    await evaluate('window.location.hash = "activity"');
    await settle();
    assert.equal(await evaluate('elements.eventList.children.length'), 2);
    await capture('activity');
    await evaluate('document.querySelector(".recovery-panel").open = true; elements.restartButton.click()');
    await settle();
    assert.equal(calls.restart, 0, 'Recovery must still require a second click.');
    await evaluate('elements.restartButton.click()');
    await settle();
    assert.equal(calls.restart, 1);
    await evaluate('document.querySelector(".tools-menu").open = true; elements.viewLogsButton.click();');
    await settle();
    assert.equal(calls.openLogs, 1);
    assert.equal(await evaluate('document.querySelector(".tools-menu").open'), false);
    await evaluate('document.querySelector(".tools-menu").open = true; elements.viewArchiveFolderButton.click();');
    await settle();
    assert.equal(calls.openFolder, 1);
    await evaluate('document.querySelector(".tools-menu").open = true; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));');
    assert.equal(await evaluate('document.querySelector(".tools-menu").open'), false);
    await evaluate('applyState({ ok: false, error: "Archive folder is unavailable." })');
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), true);
    assert.equal(await evaluate('elements.pauseResumeButton.disabled'), true);
    console.log('PASS: compact navigation, queue visibility, idle/uploading/paused/error states, minimum layout, settings persistence, all upload controls, recovery confirmation, utility actions, accessible progress, stable list rendering.');
    console.log(destination ? `Screenshots: ${destination}` : 'No screenshots requested.');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
