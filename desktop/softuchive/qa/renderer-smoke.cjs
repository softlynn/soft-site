// Run with Electron, not Node. No production controller, scheduler, or pipeline is loaded.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
const appDirectory = process.env.SOFTUCHIVE_APP_DIR || path.join(__dirname, '..');

const snapshot = {
  ok: true, settings: { archiveFolder: 'D:\\Stream Archives', pollingIntervalMinutes: 15, pollOnObsCloseEnabled: true },
  runtime: { app: {}, run: { active: false, status: 'idle', uploads: [], queue: {} }, events: [] },
  control: {}, task: { exists: true, enabled: true, state: 'Ready' },
  obsMonitor: { running: false, lastCheckedAt: new Date().toISOString() },
};
ipcMain.handle('softuchive:get-state', () => snapshot);
ipcMain.handle('softuchive:save-settings', (_event, payload) => {
  snapshot.settings = { ...snapshot.settings, ...payload };
  return { ok: true, settings: snapshot.settings };
});
ipcMain.handle('softuchive:archive-now', async () => { throw new Error('Simulated archive failure'); });
ipcMain.handle('softuchive:open-admin', () => ({ ok: true, message: 'Local admin opened.' }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: {
    preload: path.join(appDirectory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  try {
    await window.loadFile(path.join(appDirectory, 'renderer', 'index.html'));
    const evaluate = (script) => window.webContents.executeJavaScript(script);
    for (let i = 0; i < 40 && !(await evaluate('Boolean(state.latest)')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await evaluate('state.latest.ok'), true);
    assert.equal(await evaluate('document.querySelectorAll(".section-block:not([hidden])").length'), 1);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const destination = process.env.SOFTUCHIVE_SCREENSHOT_DIR;
    if (destination) {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'archive.png'), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate('window.location.hash = "automation"');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await evaluate('document.getElementById("automation").hidden'), false);
    await evaluate('elements.pollIntervalInput.value = "27"; elements.pollIntervalInput.dispatchEvent(new Event("input"));');
    assert.equal(await evaluate('state.settingsDirty'), true);
    assert.equal(await evaluate('elements.saveSettingsButton.disabled'), false);
    await evaluate('applyState(state.latest)');
    assert.equal(await evaluate('elements.pollIntervalInput.value'), '27');
    if (destination) await fs.writeFile(path.join(destination, 'settings.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('elements.saveSettingsButton.click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(snapshot.settings.archiveFolder, 'D:\\Stream Archives');
    assert.equal(snapshot.settings.pollingIntervalMinutes, 27);
    assert.equal(await evaluate('state.settingsDirty'), false);
    assert.equal(await evaluate('elements.pollIntervalInput.value'), '27');
    await evaluate('elements.archiveNowButton.click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(await evaluate('elements.noticeBanner.textContent'), /Simulated archive failure/);
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), false);
    snapshot.runtime.run = {
      active: true, status: 'running', stage: 'uploading', current: { sessionId: 'test', title: 'Saturday night • a very long stream title to check wrapping and small windows', state: 'uploading', percent: 42, uploadedBytes: 420000000, totalBytes: 1000000000, estimatedRemainingMs: 180000 },
      uploads: [{ sessionId: 'test', title: 'Saturday night', state: 'uploading', percent: 42 }], queue: { total: 3, remaining: 2 },
    };
    window.webContents.send('softuchive:state', snapshot);
    await evaluate('window.location.hash = "overview"');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate('elements.archiveNowButton.disabled'), true);
    assert.equal(await evaluate('elements.pauseResumeButton.disabled'), false);
    assert.equal(await evaluate('elements.progressFill.parentElement.getAttribute("aria-valuenow")'), '42');
    if (destination) await fs.writeFile(path.join(destination, 'uploading.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(780, 580);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await evaluate('window.location.hash = "activity"');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate('elements.uploadList.children.length'), 1);
    assert.equal(await evaluate('(() => { const first = elements.uploadList.firstChild; render(); return first === elements.uploadList.firstChild; })()'), true);
    console.log('PASS: navigation, layout, dirty settings, save, IPC error recovery, upload controls, accessible progress, stable list rendering.');
    console.log(destination ? `Screenshots: ${destination}` : 'No screenshots requested.');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
