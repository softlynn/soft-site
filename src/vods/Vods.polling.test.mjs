import test from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';
import { startVisiblePolling } from './visiblePolling.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const setup = async (t, { hidden = false, uploadPoll, readyPoll = async () => null } = {}) => {
  const listeners = new Set();
  const timers = new Map();
  let timerId = 0;
  const document = {
    hidden,
    addEventListener: (name, listener) => { if (name === 'visibilitychange') listeners.add(listener); },
    removeEventListener: (name, listener) => { if (name === 'visibilitychange') listeners.delete(listener); },
  };
  const location = { pathname: '/', search: '' };
  const clock = {
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const harness = await createComponentHarness(new URL('./Vods.js', import.meta.url), {
    '@mui/material': { ...uiElements, useMediaQuery: () => true },
    '../utils/ErrorBoundary': { default: 'ErrorBoundary' },
    '../utils/Footer': { default: 'Footer' },
    '../utils/Loading': { default: 'Loading' },
    './Vod': { default: 'Vod' },
    'react-router': { Link: 'Link', useLocation: () => location, useNavigate: () => () => {} },
    dayjs: { default: dayjs },
    'lodash.debounce': { default: callback => Object.assign(callback, { cancel() {} }) },
    './client': { default: { service: () => ({ find: async () => ({ data: [], total: 0 }) }) } },
    '../config/site': { START_DATE: '2020-01-01', SOCIAL_LINKS: {}, ENABLE_ADSENSE: false, SITE_TITLE: 'Test' },
    '@mui/icons-material/OpenInNewRounded': { default: 'OpenIcon' },
    '@mui/icons-material/VideoLibraryRounded': { default: 'LibraryIcon' },
    '../utils/Reveal': { default: 'Reveal' },
    '../api/uploadStatusApi': { fetchActiveVodUploads: uploadPoll },
    '../api/vodsApi': { getVodById: readyPoll },
    './UploadingVodPlaceholder': { default: 'UploadPlaceholder' },
    './visiblePolling.mjs': { startVisiblePolling: options => startVisiblePolling(options, { document, ...clock }) },
  }, {
    document,
    window: { ...clock, matchMedia: () => ({ matches: true }) },
    navigator: {},
    AbortController,
    URLSearchParams,
    ...clock,
    console: { ...console, error() {} },
  });
  t.after(() => harness.dispose());
  const flush = () => harness.settle();
  return {
    harness, location, listeners, document, timers, flush,
    async show(isVisible) {
      document.hidden = !isVisible;
      for (const listener of [...listeners]) listener();
      return flush();
    },
    async tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
      await harness.runIntervals();
      return flush();
    },
  };
};

const finalizingUpload = { sessionId: 'session', twitchVodId: '123', state: 'finalizing', percent: 100, partNumber: 1 };
const placeholders = tree => findElements(tree, node => node.type === 'UploadPlaceholder');
const readyCards = tree => findElements(tree, node => node.type === 'Vod');

test('archive polling waits for visibility and aborts work when hidden or unmounted', async (t) => {
  const requests = [];
  const state = await setup(t, { hidden: true, uploadPoll: ({ signal } = {}) => {
    const request = deferred(); requests.push({ ...request, signal }); return request.promise;
  } });
  state.harness.render();
  await state.flush();
  assert.equal(requests.length, 0, 'a hidden archive must not start a status request');
  await state.show(true);
  assert.equal(requests.length, 1, 'returning to the tab refreshes immediately');
  await state.tick();
  await state.tick();
  assert.equal(requests.length, 1, 'slow requests cannot overlap later polls');
  await state.show(false);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve([finalizingUpload]);
  assert.equal(placeholders(await state.flush()).length, 0, 'late hidden responses are ignored');
  await state.tick();
  assert.equal(requests.length, 1);
  await state.show(true);
  assert.equal(requests.length, 2);
  state.harness.dispose();
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(state.listeners.size, 0);
  assert.equal(state.timers.size, 0);
});

test('archive retains upload placeholders during a failed status refresh', async (t) => {
  let calls = 0;
  const state = await setup(t, { uploadPoll: async () => {
    if (calls++ === 0) return [{ ...finalizingUpload, state: 'uploading', percent: 50 }];
    throw new Error('offline');
  } });
  state.harness.render();
  assert.equal(placeholders(await state.flush()).length, 1);
  assert.equal(placeholders(await state.tick()).length, 1, 'a transient failure must keep cached upload progress visible');
});

test('readiness requests abort on navigation and cannot publish late highlights', async (t) => {
  const requests = [];
  const state = await setup(t, {
    uploadPoll: async () => [finalizingUpload],
    readyPoll: async (_, options) => {
      const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise;
    },
  });
  state.harness.render();
  await state.flush();
  assert.ok(requests[0].signal, 'readiness reads receive the lifecycle cancellation signal');
  state.location.pathname = '/vods';
  state.harness.render();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ id: '123', youtube: [{ id: 'ready' }] });
  await state.flush();
  state.location.pathname = '/';
  state.harness.render();
  const tree = await state.flush();
  assert.equal(readyCards(tree).length, 0, 'a readiness response from the previous route must not publish a highlight');
});

test('readiness polling pauses in the background and publishes a ready VOD after returning', async (t) => {
  let reads = 0;
  const state = await setup(t, {
    uploadPoll: async () => [finalizingUpload],
    readyPoll: async () => {
      reads += 1;
      return { id: '123', youtube: reads > 1 ? [{ id: 'ready' }] : [] };
    },
  });
  state.harness.render();
  await state.flush();
  assert.equal(reads, 1);
  await state.show(false);
  for (let i = 0; i < 30; i += 1) await state.tick();
  assert.equal(reads, 1, 'hidden time must not spend readiness attempts');
  const tree = await state.show(true);
  assert.equal(reads, 2, 'readiness resumes immediately');
  assert.equal(readyCards(tree).length, 1);
  for (let i = 0; i < 3; i += 1) await state.tick();
  assert.equal(reads, 2, 'a ready session stops polling its metadata');
});
