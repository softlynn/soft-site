import test from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import debounce from 'lodash.debounce';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';
import { startVisiblePolling } from './visiblePolling.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const setup = async (t, { hidden = false, uploadPoll, readyPoll = async () => null, initialLocation, debounceFactory, mobile = true, reduceMotion = true, resultTotal = 0, onRender } = {}) => {
  const listeners = new Set();
  const timers = new Map();
  let timerId = 0;
  const document = {
    hidden,
    addEventListener: (name, listener) => { if (name === 'visibilitychange') listeners.add(listener); },
    removeEventListener: (name, listener) => { if (name === 'visibilitychange') listeners.delete(listener); },
  };
  const location = { pathname: '/', search: '', ...initialLocation };
  const navigations = [];
  const queries = [];
  const navigate = url => navigations.push(url);
  const clock = {
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const harness = await createComponentHarness(new URL('./Vods.js', import.meta.url), {
    '@mui/material': Object.assign(Object.create(uiElements), { useMediaQuery: () => mobile }),
    '../utils/ErrorBoundary': { default: 'ErrorBoundary' },
    '../utils/Footer': { default: 'Footer' },
    '../utils/Loading': { default: 'Loading' },
    './Vod': { default: 'Vod' },
    'react-router': { Link: 'Link', useLocation: () => location, useNavigate: () => navigate },
    dayjs: { default: dayjs },
    'lodash.debounce': { default: debounceFactory || (callback => Object.assign(callback, { cancel() {} })) },
    './client': { default: { service: () => ({ find: async ({ query }) => { queries.push(query); return { data: [], total: resultTotal }; } }) } },
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
    window: { ...clock, matchMedia: () => ({ matches: reduceMotion }) },
    navigator: {},
    AbortController,
    URLSearchParams,
    ...clock,
    console: { ...console, error() {} },
  }, onRender);
  t.after(() => harness.dispose());
  const flush = () => harness.settle();
  return {
    harness, location, listeners, document, timers, flush, queries, navigations,
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

test('clearing archive filters cancels pending searches and returns to the unfiltered first page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-09-29T12:00:00Z') });
  const state = await setup(t, { uploadPoll: async () => [], initialLocation: { pathname: '/vods', search: '?page=4' }, debounceFactory: debounce });
  const controls = tree => findElements(tree, node => typeof node.props.handleTitleChange === 'function')[0];
  let tree = state.harness.render();
  await state.flush();
  controls(tree).props.changeFilter({ target: { value: 'Game' } });
  controls(tree).props.handleTitleChange({ target: { value: 'pending title' } });
  controls(tree).props.handleGameChange({ target: { value: 'pending game' } });
  controls(tree).props.setFilterStartDate(dayjs('2021-05-01'));
  tree = await state.flush();
  assert.equal(typeof controls(tree).props.onResetFilters, 'function');
  controls(tree).props.onResetFilters();
  state.location.search = '?page=1';
  tree = state.harness.render();
  await state.flush();
  const countAfterReset = state.queries.length;
  t.mock.timers.tick(500);
  tree = await state.flush();
  assert.equal(state.queries.length, countAfterReset, 'canceled searches must not trigger a later stale query');
  assert.equal(controls(tree).props.filter, 'Default');
  assert.equal(controls(tree).props.filterTitle, '');
  assert.equal(controls(tree).props.filterGame, '');
  assert.equal(controls(tree).props.filterStartDate.format('YYYY-MM-DD'), '2020-01-01');
  assert.equal(state.queries.at(-1).$skip, 0);
  assert.equal(state.queries.at(-1).$and.length, 1);
  assert.equal(state.navigations.at(-1), '/vods?page=1');
});

for (const mobile of [true, false]) {
  test(`explicit archive pagination scrolls the ${mobile ? 'native' : 'SimpleBar'} container but filters and polls do not`, async (t) => {
    const scrolls = [];
    const scroller = { scrollTo: options => scrolls.push({ ...options }) };
    const state = await setup(t, {
      uploadPoll: async () => [], initialLocation: { pathname: '/vods' }, mobile, reduceMotion: mobile, resultTotal: 80,
      onRender: tree => {
        for (const node of findElements(tree, item => String(item.props.className || '').includes('soft-vods-scroll'))) {
          const ref = mobile ? node.props.ref : node.props.scrollableNodeProps?.ref;
          if (ref) ref.current = scroller;
        }
      },
    });
    state.harness.render();
    let tree = await state.flush();
    let pagination = findElements(tree, node => node.type === 'Pagination')[0];
    pagination.props.onChange({}, 2);
    assert.deepEqual(scrolls, [{ top: 0, behavior: mobile ? 'auto' : 'smooth' }]);
    state.location.search = '?page=2';
    tree = state.harness.render();
    pagination = findElements(tree, node => node.type === 'Pagination')[0];
    pagination.props.onChange({}, 2);
    pagination.props.onChange({ ctrlKey: true }, 3);
    findElements(tree, node => typeof node.props.changeFilter === 'function')[0].props.changeFilter({ target: { value: 'Game' } });
    tree = await state.tick();
    assert.equal(scrolls.length, 1, 'same-page, new-tab navigation, filters and upload polling do not move the page');
    findElements(tree, node => node.type === 'TextField' && node.props.inputProps?.['aria-label'] === 'Go to page')[0].props.onKeyDown({ key: 'Enter', target: { value: '3' } });
    assert.equal(scrolls.length, 2);
    assert.equal(state.navigations.at(-1), '/vods?page=3');
  });
}

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
