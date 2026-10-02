const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

// Exercise the actual desktop controller with real, isolated state files.
// Electron and Windows process launches are replaced to keep tests off the user's tasks.
async function controller(t, { openError = '', adminService = 'soft-admin-api', taskError = '', obsSamples = [], onObsCheck, allowPipeline = false, recoveryReadError, recoveryWriteError, pipelineRunLockPath = '', verifyRecoveryLock = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'softuchive-desktop-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateModule = await import('../../scripts/softuchive_state.mjs');
  const pipelineFileIo = await import('../../scripts/pipeline_file_io.mjs');
  const pipelineRunLock = await import('../../scripts/pipeline_run_lock.mjs');
  const configuredRunLockPath = typeof pipelineRunLockPath === 'function' ? pipelineRunLockPath(root) : pipelineRunLockPath;
  const runLockPath = path.resolve(root, configuredRunLockPath || path.join('scripts', '.state', 'pipeline-run.lock.json'));
  const recoveryLockChecks = [];
  const checkRecoveryLock = async (phase) => {
    if (!verifyRecoveryLock) return;
    const contender = await pipelineRunLock.acquirePipelineRunLock(runLockPath);
    if (contender) await contender();
    assert.equal(contender, null, `Restart must own the worker lock during ${phase}`);
    recoveryLockChecks.push(phase);
  };
  const recoveryWrites = [];
  const observedFileIo = {
    ...pipelineFileIo,
    async writeJsonFileAtomic(filePath, payload, options) {
      await checkRecoveryLock('write');
      recoveryWrites.push({ filePath, payload, options });
      if (recoveryWriteError) throw recoveryWriteError;
      return pipelineFileIo.writeJsonFileAtomic(filePath, payload, options);
    },
  };
  const handlers = new Map();
  const rawHandlers = new Map();
  let taskReads = 0;
  let obsReads = 0;
  let stateReads = 0;
  const openedUrls = [];
  const broadcasts = [];
  const pipelineLaunches = [];
  const windowState = { visible: true, minimized: false };
  const mainFrame = { url: pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href };
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel, state) => broadcasts.push({ channel, state }) };
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const testWindow = {
    webContents, isDestroyed: () => false,
    isVisible: () => windowState.visible, isMinimized: () => windowState.minimized,
  };
  const observedStateModule = {
    ...stateModule,
    readSoftuchiveRuntime(...args) {
      stateReads += 1;
      return stateModule.readSoftuchiveRuntime(...args);
    },
    async writeSoftuchiveControl(...args) {
      await checkRecoveryLock('control');
      return stateModule.writeSoftuchiveControl(...args);
    },
  };
  const sandbox = {
    require(name) {
      if (name === 'node:fs/promises') return {
        ...fs,
        async readFile(filePath, ...args) {
          if (filePath === path.join(root, 'scripts', '.state', 'pipeline-state.json')) {
            await checkRecoveryLock('read');
            if (recoveryReadError) throw recoveryReadError;
          }
          return fs.readFile(filePath, ...args);
        },
      };
      if (name === 'electron') return {
        app: { requestSingleInstanceLock: () => false, quit() {}, on() {} },
        ipcMain: { handle(name, handler) {
          rawHandlers.set(name, handler);
          handlers.set(name, (_event, ...args) => handler(trustedEvent, ...args));
        } },
        shell: { openPath: async () => openError, openExternal: async (url) => { openedUrls.push(url); } },
      };
      if (name === 'node:child_process') return {
        execFile(file, args, options, callback) {
          assert.equal(options.windowsHide, true, 'desktop subprocesses must stay hidden');
          if (file === 'tasklist.exe') {
            const running = obsSamples[obsReads++] === true;
            const respond = () => setImmediate(() => callback(null, running ? '"obs64.exe","1234","Console","1","90,000 K"' : 'INFO: No tasks are running.', ''));
            if (onObsCheck) onObsCheck(obsReads, respond);
            else respond();
            return;
          }
          taskReads += 1;
          setImmediate(() => callback(null, JSON.stringify(taskError
            ? { exists: null, enabled: false, state: 'Unavailable', error: taskError }
            : { exists: false, enabled: false, state: 'NotInstalled' }), ''));
        },
        spawn(file, args, options) {
          if (!allowPipeline) throw new Error('Tests must not launch a real pipeline');
          assert.equal(options.windowsHide, true);
          if (verifyRecoveryLock) {
            assert.equal(require('node:fs').existsSync(runLockPath), false, 'Restart must release worker ownership before launch');
            assert.equal(require('node:fs').existsSync(`${runLockPath}.lock`), false, 'Restart must release the shared guard before launch');
            recoveryLockChecks.push('launch');
          }
          pipelineLaunches.push({ file, args, options });
          return Object.assign(new EventEmitter(), { exitCode: null });
        },
      };
      return require(name);
    },
    process: { ...process, env: { ...process.env, LOCAL_RECORDINGS_DIR: path.join(root, 'fallback'), PIPELINE_RUN_LOCK_PATH: configuredRunLockPath } },
    __dirname, console, setInterval, clearInterval, setTimeout, clearTimeout, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, service: adminService }) }),
    testRoot: root, testModule: observedStateModule, testFileIo: observedFileIo, testRunLock: pipelineRunLock, testWindow,
  };
  vm.createContext(sandbox);
  const source = process.env.SOFTUCHIVE_APP_ASAR
    ? require('@electron/asar').extractFile(process.env.SOFTUCHIVE_APP_ASAR, 'main.cjs').toString('utf8')
    : await fs.readFile(path.join(__dirname, 'main.cjs'), 'utf8');
  vm.runInContext(`${source}\nrepoRoot = testRoot; mainWindow = testWindow; softuchiveStateModulePromise = Promise.resolve(testModule); pipelineFileIoModulePromise = Promise.resolve(testFileIo); pipelineRunLockModulePromise = Promise.resolve(testRunLock); globalThis.controller = { updateSettings, buildAppState, getScheduledTaskStatus, openExistingPath, tickObsMonitor, broadcastState };`, sandbox);
  return {
    root, stateModule, pipelineRunLock, runLockPath, recoveryLockChecks, api: sandbox.controller, handlers, rawHandlers, trustedEvent, openedUrls, broadcasts, windowState, pipelineLaunches, recoveryWrites,
    get taskReads() { return taskReads; }, get obsReads() { return obsReads; }, get stateReads() { return stateReads; },
  };
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

test('restart retains upload recovery evidence and a changed source still cannot start another upload', async (t) => {
  const context = await controller(t, { allowPipeline: true, verifyRecoveryLock: true });
  const recordingPath = path.join(context.root, 'recordings', 'paused.mp4');
  const processingPath = path.join(context.root, 'recordings', 'processing.mp4');
  const completedPath = path.join(context.root, 'recordings', 'completed.mp4');
  const source = { size: 100, modifiedAtMs: 1000, changedAtMs: 1000, fileId: 'source-file', deviceId: 'disk' };
  const preparedPath = path.join(context.root, 'scripts', '.tmp', 'earlier-track1.mp4');
  const paused = {
    status: 'paused', source,
    preparedUploadCopy: { path: preparedPath, originalPath: recordingPath, uploadCopyManifestPath: `${preparedPath}.json` },
    uploadSessionId: 'earlier-session', uploadedBytes: 90, totalBytes: 100,
    youtubeVideoId: 'known-upload', pendingVodEntry: { id: 'twitch-vod', youtube: [{ id: 'known-upload', part: 1 }] },
    finalAttempted: true, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
  };
  const processing = { ...paused, status: 'processing', youtubeVideoId: null, uploadSessionId: 'processing-session' };
  const completed = { ...paused, status: 'completed', uploadArtifactsClearedAt: '2026-01-01T00:02:00.000Z' };
  const initial = {
    processedFiles: { [recordingPath]: paused, [processingPath]: processing, [completedPath]: completed },
    processedVodIds: { 'twitch-vod': { metadataVersion: 8 } },
  };
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  await fs.writeFile(pipelinePath, JSON.stringify(initial));
  await context.stateModule.writeSoftuchiveRuntime(context.root, { run: { active: false, status: 'paused' } });
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true, uploadPaused: true, uploadThrottleMbps: 5 });

  const result = await context.handlers.get('softuchive:restart')();
  assert.equal(result.ok, true);
  assert.match(result.message, /Queued 2 interrupted archive\(s\) for retry/);
  assert.equal(context.pipelineLaunches.length, 1);
  assert.equal(context.pipelineLaunches[0].args[1], '--trigger=restart');
  assert.equal(context.recoveryWrites.length, 1);
  assert.equal(context.recoveryWrites[0].options.durable, true);
  assert.deepEqual(context.recoveryLockChecks, ['read', 'write', 'control', 'launch']);
  const saved = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  for (const [filePath, before] of [[recordingPath, paused], [processingPath, processing]]) {
    const after = saved.processedFiles[filePath];
    assert.equal(after.status, 'error');
    assert.match(after.error, /retained source and prepared upload identity/);
    assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt));
    for (const key of Object.keys(before).filter((key) => !['status', 'updatedAt'].includes(key))) {
      assert.deepEqual(after[key], before[key], `Restart lost ${key}`);
    }
  }
  assert.deepEqual(saved.processedFiles[completedPath], completed);
  assert.deepEqual(saved.processedVodIds, initial.processedVodIds);
  const control = await context.stateModule.readSoftuchiveControl(context.root);
  assert.equal(control.pauseRequested, false);
  assert.equal(control.uploadPaused, true);
  assert.equal(control.uploadThrottleMbps, 5);

  const { assertRecordingUploadRecoverySafe } = await import('../../scripts/pipeline_recording_recovery.mjs');
  await assert.rejects(() => assertRecordingUploadRecoverySafe({
    recording: { ...source, path: recordingPath, modifiedAtMs: 2000 },
    checkpoint: saved.processedFiles[recordingPath],
    cacheRoot: path.join(context.root, 'scripts', '.tmp'),
    sessionDirectory: path.join(context.root, 'scripts', '.state', 'upload-sessions'),
  }), { code: 'SOFTUCHIVE_RECORDING_RECOVERY_REQUIRED' });
  const savedText = await fs.readFile(pipelinePath, 'utf8');
  assert.equal((await context.handlers.get('softuchive:restart')()).ok, false);
  assert.equal(await fs.readFile(pipelinePath, 'utf8'), savedText);
  assert.equal(context.recoveryWrites.length, 1, 'a still-starting child must exclude another restart mutation');
});

test('restart honors worker ownership despite an inactive runtime, including configured lock paths', async (t) => {
  for (const [name, pipelineRunLockPath] of [
    ['default', ''], ['relative', path.join('custom-locks', 'scheduled-worker.json')],
    ['absolute', (root) => path.join(root, 'absolute-locks', 'scheduled-worker.json')],
  ]) {
    await t.test(name, async (t) => {
      const context = await controller(t, { allowPipeline: true, pipelineRunLockPath });
      await context.stateModule.ensureSoftuchiveStateFiles(context.root);
      await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true, uploadThrottleMbps: 4 });
      const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
      const original = '{"processedFiles":{"recording":{"status":"paused","source":{"size":100,"modifiedAtMs":1000}}}}';
      await fs.writeFile(pipelinePath, original);
      const controlBefore = await context.stateModule.readSoftuchiveControl(context.root);
      const releaseWorker = await context.pipelineRunLock.acquirePipelineRunLock(context.runLockPath);
      assert.equal(typeof releaseWorker, 'function');
      try {
        const result = await context.handlers.get('softuchive:restart')();
        assert.equal(result.ok, false);
        assert.match(result.message, /worker is still running/);
        assert.equal(await fs.readFile(pipelinePath, 'utf8'), original);
        assert.deepEqual(await context.stateModule.readSoftuchiveControl(context.root), controlBefore);
        assert.equal(context.recoveryWrites.length, 0);
        assert.equal(context.pipelineLaunches.length, 0);
      } finally {
        await releaseWorker();
      }
    });
  }
});

const assertRestartLockAvailable = async (context) => {
  const release = await context.pipelineRunLock.acquirePipelineRunLock(context.runLockPath);
  assert.equal(typeof release, 'function', 'Restart leaked the worker lock after failure');
  await release();
};

test('restart refuses an active run without changing its checkpoint or controls', async (t) => {
  const context = await controller(t);
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  const checkpoint = JSON.stringify({ processedFiles: { recording: { status: 'processing', source: { size: 100, modifiedAtMs: 1000 } } } });
  await fs.writeFile(pipelinePath, checkpoint);
  await context.stateModule.writeSoftuchiveRuntime(context.root, { run: { active: true, status: 'running' } });
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true });
  const result = await context.handlers.get('softuchive:restart')();
  assert.equal(result.ok, false);
  assert.match(result.message, /still running/);
  assert.equal(await fs.readFile(pipelinePath, 'utf8'), checkpoint);
  assert.equal((await context.stateModule.readSoftuchiveControl(context.root)).pauseRequested, true);
  assert.equal(context.pipelineLaunches.length, 0);
});

test('restart rejects malformed recovery JSON and maps without replacing history or resuming', async (t) => {
  const context = await controller(t, { allowPipeline: true });
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true, uploadThrottleMbps: 5 });
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  const controlBefore = await context.stateModule.readSoftuchiveControl(context.root);
  for (const contents of [
    '{"private": "secret-sentinel", broken', 'null', '[]',
    '{"processedFiles":null}', '{"processedFiles":[]}', '{"processedFiles":{"recording":null}}',
    '{"processedVodIds":[]}', '{"processedVodIds":{"vod":"invalid"}}',
  ]) {
    await fs.writeFile(pipelinePath, contents);
    await assert.rejects(() => context.handlers.get('softuchive:restart')(), (error) => {
      assert.match(error.message, /Repair or restore/);
      assert.ok(!String(error.stack).includes('secret-sentinel'));
      return true;
    });
    assert.equal(await fs.readFile(pipelinePath, 'utf8'), contents);
    assert.deepEqual(await context.stateModule.readSoftuchiveControl(context.root), controlBefore);
    await assertRestartLockAvailable(context);
  }
  assert.equal(context.pipelineLaunches.length, 0);
  assert.equal(context.recoveryWrites.length, 0);
});

test('restart preserves history and controls when recovery state cannot be read', async (t) => {
  const context = await controller(t, { allowPipeline: true, recoveryReadError: Object.assign(new Error('secret-sentinel'), { code: 'EACCES' }) });
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true });
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  const original = '{"processedFiles":{"recording":{"status":"paused","source":{"size":100,"modifiedAtMs":1000}}}}';
  await fs.writeFile(pipelinePath, original);
  const controlBefore = await context.stateModule.readSoftuchiveControl(context.root);
  await assert.rejects(() => context.handlers.get('softuchive:restart')(), (error) => {
    assert.match(error.message, /Cannot read pipeline-state.json/);
    assert.ok(!String(error.stack).includes('secret-sentinel'));
    return true;
  });
  assert.equal(await fs.readFile(pipelinePath, 'utf8'), original);
  assert.deepEqual(await context.stateModule.readSoftuchiveControl(context.root), controlBefore);
  assert.equal(context.pipelineLaunches.length, 0);
  assert.equal(context.recoveryWrites.length, 0);
  await assertRestartLockAvailable(context);
});

test('restart waits for durable recovery persistence before clearing pause or launching', async (t) => {
  const context = await controller(t, { allowPipeline: true, recoveryWriteError: Object.assign(new Error('secret-sentinel'), { code: 'ENOSPC' }) });
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  await context.stateModule.writeSoftuchiveControl(context.root, { pauseRequested: true, uploadThrottleMbps: 3 });
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  const checkpoint = { status: 'paused', source: { size: 100, modifiedAtMs: 1000 }, youtubeVideoId: 'known-video' };
  const original = JSON.stringify({ processedFiles: { recording: checkpoint }, processedVodIds: {} });
  await fs.writeFile(pipelinePath, original);
  const controlBefore = await context.stateModule.readSoftuchiveControl(context.root);
  await assert.rejects(() => context.handlers.get('softuchive:restart')(), (error) => {
    assert.match(error.message, /Cannot save pipeline-state.json/);
    assert.ok(!String(error.stack).includes('secret-sentinel'));
    return true;
  });
  assert.equal(await fs.readFile(pipelinePath, 'utf8'), original);
  assert.deepEqual(await context.stateModule.readSoftuchiveControl(context.root), controlBefore);
  assert.equal(context.pipelineLaunches.length, 0);
  assert.equal(context.recoveryWrites.length, 1);
  assert.equal(context.recoveryWrites[0].options.durable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.recoveryWrites[0].payload.processedFiles.recording.source)), checkpoint.source);
  await assertRestartLockAvailable(context);
});

test('restart permits first-run absence of recovery state', async (t) => {
  const context = await controller(t, { allowPipeline: true });
  await context.stateModule.ensureSoftuchiveStateFiles(context.root);
  const result = await context.handlers.get('softuchive:restart')();
  assert.equal(result.ok, true);
  const pipelinePath = path.join(context.root, 'scripts', '.state', 'pipeline-state.json');
  assert.deepEqual(JSON.parse(await fs.readFile(pipelinePath, 'utf8')), { processedFiles: {}, processedVodIds: {} });
  assert.equal(context.pipelineLaunches.length, 1);
  assert.equal(context.recoveryWrites[0].options.durable, true);
  await assertRestartLockAvailable(context);
});

test('disabled OBS monitoring does not launch processes or refresh pipeline state', async (t) => {
  const context = await controller(t);
  await context.api.tickObsMonitor();
  await context.api.tickObsMonitor();
  assert.equal(context.obsReads, 0);
  assert.equal(context.taskReads, 0);
  assert.equal(context.stateReads, 0);
});

test('re-enabling OBS monitoring starts with a fresh process sample', async (t) => {
  const context = await controller(t, { obsSamples: [true, false] });
  await context.api.updateSettings({ pollOnObsCloseEnabled: true });
  await context.api.tickObsMonitor();
  assert.equal((await context.api.buildAppState()).obsMonitor.running, true);
  await context.api.updateSettings({ pollOnObsCloseEnabled: false });
  await context.api.updateSettings({ pollOnObsCloseEnabled: true });
  await context.api.tickObsMonitor();
  const state = await context.api.buildAppState();
  assert.equal(context.obsReads, 2);
  assert.equal(state.obsMonitor.running, false);
  assert.equal(state.obsMonitor.lastClosedAt, null);
  assert.equal(state.obsMonitor.error, null);
});

test('unchanged OBS checks do not repaint the renderer', async (t) => {
  const context = await controller(t, { obsSamples: [true, true] });
  await context.api.updateSettings({ pollOnObsCloseEnabled: true });
  await context.api.tickObsMonitor();
  const broadcastsAfterFirstCheck = context.broadcasts.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await context.api.tickObsMonitor();
  assert.equal(context.obsReads, 2);
  assert.equal(context.broadcasts.length, broadcastsAfterFirstCheck);
});

test('hidden and minimized windows skip periodic state reads and refresh when visible', async (t) => {
  const context = await controller(t);
  await context.api.broadcastState();
  const initialReads = context.stateReads;
  const initialBroadcasts = context.broadcasts.length;
  context.windowState.minimized = true;
  await context.api.broadcastState();
  context.windowState.minimized = false;
  context.windowState.visible = false;
  await context.api.broadcastState();
  assert.equal(context.stateReads, initialReads);
  assert.equal(context.broadcasts.length, initialBroadcasts);
  context.windowState.visible = true;
  await context.api.broadcastState(true);
  assert.equal(context.stateReads, initialReads + 1);
  assert.equal(context.broadcasts.length, initialBroadcasts + 1);
});

test('IPC rejects foreign windows, subframes, and navigated frames before actions run', async (t) => {
  const context = await controller(t);
  const pause = context.rawHandlers.get('softuchive:pause');
  for (const event of [
    undefined,
    { ...context.trustedEvent, sender: {} },
    { ...context.trustedEvent, senderFrame: { url: context.trustedEvent.senderFrame.url } },
  ]) {
    await assert.rejects(Promise.resolve().then(() => pause(event)), /trusted Softuchive window/);
  }
  context.trustedEvent.senderFrame.url = 'https://example.com/';
  await assert.rejects(Promise.resolve().then(() => pause(context.trustedEvent)), /trusted Softuchive window/);
  assert.equal((await context.stateModule.readSoftuchiveControl(context.root)).pauseRequested, false);
  assert.equal(context.stateReads, 0);
  assert.equal(context.taskReads, 0);
});

test('IPC remains available after navigating to a local app section', async (t) => {
  const context = await controller(t);
  context.trustedEvent.senderFrame.url += '#automation';
  const state = await context.handlers.get('softuchive:get-state')();
  assert.equal(state.ok, true);
  const result = await context.handlers.get('softuchive:pause')();
  assert.equal(result.ok, true);
  assert.equal((await context.stateModule.readSoftuchiveControl(context.root)).pauseRequested, true);
});

test('enabled OBS automation still launches one archive when the app is minimized', async (t) => {
  const context = await controller(t, { obsSamples: [true, false, false], allowPipeline: true });
  await context.api.updateSettings({ pollOnObsCloseEnabled: true });
  context.windowState.minimized = true;
  await context.api.tickObsMonitor();
  await context.api.tickObsMonitor();
  await context.api.tickObsMonitor();
  assert.equal(context.pipelineLaunches.length, 1);
  assert.equal(context.pipelineLaunches[0].args[1], '--trigger=obs-close');
  assert.equal(context.pipelineLaunches[0].options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('disabling OBS monitoring discards a process sample already in flight', async (t) => {
  let sampleStarted;
  const secondSample = new Promise((resolve) => { sampleStarted = resolve; });
  const context = await controller(t, {
    obsSamples: [true, false], allowPipeline: true,
    onObsCheck(count, respond) {
      if (count === 2) sampleStarted(respond);
      else respond();
    },
  });
  await context.api.updateSettings({ pollOnObsCloseEnabled: true });
  await context.api.tickObsMonitor();
  const pendingTick = context.api.tickObsMonitor();
  const finishSample = await secondSample;
  await context.api.updateSettings({ pollOnObsCloseEnabled: false });
  finishSample();
  await pendingTick;
  assert.equal(context.pipelineLaunches.length, 0);
  const state = await context.api.buildAppState();
  assert.equal(state.obsMonitor.lastCheckedAt, null);
  assert.equal(state.obsMonitor.lastClosedAt, null);
});
