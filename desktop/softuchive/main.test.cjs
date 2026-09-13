const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual desktop controller with real, isolated state files.
// Electron and Windows process launches are replaced to keep tests off the user's tasks.
async function controller(t, { openError = '', adminService = 'soft-admin-api', taskError = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'softuchive-desktop-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateModule = await import('../../scripts/softuchive_state.mjs');
  const handlers = new Map();
  let taskReads = 0;
  const openedUrls = [];
  const sandbox = {
    require(name) {
      if (name === 'electron') return {
        app: { requestSingleInstanceLock: () => false, quit() {}, on() {} },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        shell: { openPath: async () => openError, openExternal: async (url) => { openedUrls.push(url); } },
      };
      if (name === 'node:child_process') return {
        execFile(file, args, options, callback) {
          taskReads += 1;
          setImmediate(() => callback(null, JSON.stringify(taskError
            ? { exists: null, enabled: false, state: 'Unavailable', error: taskError }
            : { exists: false, enabled: false, state: 'NotInstalled' }), ''));
        },
        spawn() { throw new Error('Tests must not launch a real pipeline'); },
      };
      return require(name);
    },
    process: { ...process, env: { ...process.env, LOCAL_RECORDINGS_DIR: path.join(root, 'fallback') } },
    __dirname, console, setInterval, clearInterval, setTimeout, clearTimeout, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, service: adminService }) }),
    testRoot: root, testModule: stateModule,
  };
  vm.createContext(sandbox);
  const source = process.env.SOFTUCHIVE_APP_ASAR
    ? require('@electron/asar').extractFile(process.env.SOFTUCHIVE_APP_ASAR, 'main.cjs').toString('utf8')
    : await fs.readFile(path.join(__dirname, 'main.cjs'), 'utf8');
  vm.runInContext(`${source}\nrepoRoot = testRoot; softuchiveStateModulePromise = Promise.resolve(testModule); globalThis.controller = { updateSettings, buildAppState, getScheduledTaskStatus, openExistingPath };`, sandbox);
  return { root, stateModule, api: sandbox.controller, handlers, openedUrls, get taskReads() { return taskReads; } };
}

test('changing the schedule preserves a custom archive folder and other preferences', async (t) => {
  const context = await controller(t);
  const customFolder = path.join(context.root, 'custom-recordings');
  await context.stateModule.writeSoftuchiveSettings(context.root, { archiveFolder: customFolder, pollOnObsCloseEnabled: true });
  await context.api.updateSettings({ pollingIntervalMinutes: 27 });
  const saved = await context.stateModule.readSoftuchiveSettings(context.root);
  assert.equal(saved.archiveFolder, customFolder);
  assert.equal(saved.pollOnObsCloseEnabled, true);
  assert.equal(saved.pollingIntervalMinutes, 27);
});

test('state refreshes reuse a recent Windows scheduled task result', async (t) => {
  const context = await controller(t);
  const states = await Promise.all([context.api.buildAppState(), context.api.buildAppState()]);
  assert.equal(states.every((state) => state.ok), true);
  await context.api.buildAppState();
  assert.equal(context.taskReads, 1);
});

test('Explorer failures are returned as actionable errors', async (t) => {
  const context = await controller(t, { openError: 'The system cannot find the path specified.' });
  const result = await context.api.openExistingPath(context.root);
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot find the path/);
});

test('Open admin opens the verified local console without launching a second server', async (t) => {
  const context = await controller(t);
  const handler = context.handlers.get('softuchive:open-admin');
  assert.equal(typeof handler, 'function');
  const result = await handler();
  assert.equal(result.ok, true);
  assert.match(context.openedUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/console\/admin$/);
  assert.equal(context.taskReads, 0);
});

test('an unverifiable Windows task change is not reported as success', async (t) => {
  const context = await controller(t, { taskError: 'Task scheduler is unavailable' });
  const result = await context.handlers.get('softuchive:set-auto-polling')(null, { enabled: true, intervalMinutes: 20 });
  assert.equal(result.ok, false);
  assert.match(result.message, /scheduler is unavailable/);
});

test('concurrent folder and interval edits retain both changes', async (t) => {
  const context = await controller(t);
  const newFolder = path.join(context.root, 'new-recordings');
  await context.stateModule.writeSoftuchiveSettings(context.root, { archiveFolder: path.join(context.root, 'old-recordings') });
  await Promise.all([
    context.api.updateSettings({ archiveFolder: newFolder }),
    context.api.updateSettings({ pollingIntervalMinutes: 32 }),
  ]);
  const saved = await context.stateModule.readSoftuchiveSettings(context.root);
  assert.equal(saved.archiveFolder, newFolder);
  assert.equal(saved.pollingIntervalMinutes, 32);
});

test('skip requests are cooperative and leave current runtime ownership intact', async (t) => {
  const context = await controller(t);
  await context.stateModule.writeSoftuchiveRuntime(context.root, {
    run: { active: true, status: 'running', pid: process.pid, current: { sessionId: 'safe-skip-test', state: 'uploading', title: 'Test VOD' } },
  });
  const result = await context.handlers.get('softuchive:skip-current-vod')();
  assert.equal(result.ok, true);
  const control = await context.stateModule.readSoftuchiveControl(context.root);
  assert.equal(control.skipRequestedUploadSessionId, 'safe-skip-test');
  const runtime = await context.stateModule.readSoftuchiveRuntime(context.root);
  assert.equal(runtime.run.active, true);
  assert.equal(runtime.run.current.state, 'uploading');
});

test('resuming a run still reaching its pause point clears the request without starting another run', async (t) => {
  const context = await controller(t);
  await context.stateModule.writeSoftuchiveRuntime(context.root, { run: { active: true, status: 'running', pid: process.pid } });
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true });
  const result = await context.handlers.get('softuchive:resume')();
  assert.equal(result.ok, true);
  assert.equal((await context.stateModule.readSoftuchiveControl(context.root)).pauseRequested, false);
});

test('changing a speed limit does not silently resume a paused upload', async (t) => {
  const context = await controller(t);
  await context.stateModule.writeSoftuchiveControl(context.root, { uploadPaused: true });
  const result = await context.handlers.get('softuchive:set-upload-control')(null, { throttleEnabled: true, uploadThrottleMbps: 5 });
  assert.equal(result.ok, true);
  const control = await context.stateModule.readSoftuchiveControl(context.root);
  assert.equal(control.uploadPaused, true);
  assert.equal(control.uploadThrottleMbps, 5);
});
