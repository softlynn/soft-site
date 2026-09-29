import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let moduleId = 0;
const loadApi = async ({ useStatic = true } = {}) => {
  const source = (await readFile(new URL('../api/vodsApi.js', import.meta.url), 'utf8'))
    .replace('import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";', `const USE_STATIC_ARCHIVE = ${useStatic}; const VODS_API_BASE = "";`)
    .replace('"../vods/replayUtils.mjs"', JSON.stringify(new URL('./replayUtils.mjs', import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// isolated test ${moduleId++}`).toString('base64')}`);
};

test('canceling the last metadata reader aborts its download and preserves the cached archive', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = await loadApi();
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: '123', title: 'Cached' }] });
  await api.getVodById('123');
  let networkSignal;
  globalThis.fetch = async (_, { signal }) => {
    networkSignal = signal;
    return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = api.getVodById('123', { forceRefresh: true, signal: controller.signal });
  assert.ok(networkSignal, 'the network download must be cancellable');
  const canceled = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await canceled;
  assert.equal(networkSignal.aborted, true);
  assert.equal((await api.getVodById('123')).title, 'Cached', 'canceling cannot replace the good cached data');
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: '123', title: 'Fresh' }] });
  assert.equal((await api.getVodById('123', { forceRefresh: true })).title, 'Fresh', 'a canceled request must not poison the next refresh');
});

test('canceling one metadata reader keeps a download needed by another reader', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = await loadApi();
  let finish;
  let networkSignal;
  let calls = 0;
  globalThis.fetch = async (_, { signal }) => {
    calls += 1;
    networkSignal = signal;
    return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => [{ id: '123' }] }); });
  };
  const controller = new AbortController();
  const canceledReader = api.getVodById('123', { signal: controller.signal });
  const retainedReader = api.findVodsStatic();
  const canceled = assert.rejects(canceledReader, { name: 'AbortError' });
  controller.abort();
  finish();
  await canceled;
  assert.equal(networkSignal.aborted, false);
  assert.equal((await retainedReader).total, 1);
  assert.equal(calls, 1);
});

test('an aborted download that finishes late cannot overwrite newer metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = await loadApi();
  let finishOld;
  let calls = 0;
  globalThis.fetch = async () => {
    if (calls++ === 0) return new Promise(resolve => {
      finishOld = () => resolve({ ok: true, json: async () => [{ id: '123', title: 'Old' }] });
    });
    return { ok: true, json: async () => [{ id: '123', title: 'New' }] };
  };
  const controller = new AbortController();
  const pending = api.getVodById('123', { signal: controller.signal });
  const canceled = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  // Let the original request finish even though it ignored cancellation.
  const fresh = api.getVodById('123', { forceRefresh: true });
  finishOld();
  await canceled;
  assert.equal((await fresh).title, 'New');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await api.getVodById('123')).title, 'New');
});

test('remote metadata reads forward cancellation to the network', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = await loadApi({ useStatic: false });
  const controller = new AbortController();
  let networkSignal;
  globalThis.fetch = async (_, { signal }) => {
    networkSignal = signal;
    return { ok: true, json: async () => ({ id: '123' }) };
  };
  await api.getVodById('123', { signal: controller.signal });
  assert.equal(networkSignal, controller.signal);
});

test('archive readers share one request and readiness can explicitly refresh metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true, json: async () => [{ id: '123', title: 'Stream', youtube: [{ id: 'video', duration: 100 }] }] };
  };
  const api = await loadApi();
  const [vod, result] = await Promise.all([api.getVodById('123'), api.findVodsStatic({})]);
  assert.equal(calls, 1);
  assert.equal(vod.youtube[0].part, 1);
  assert.equal(result.total, 1);
  await api.getVodById('123');
  assert.equal(calls, 1);
  await api.getVodById('123', { forceRefresh: true });
  assert.equal(calls, 2);
});

test('concurrent chat syncs share a download and failures remain retryable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: calls > 1, json: async () => [{ id: 'a', content_offset_seconds: 1 }] };
  };
  const api = await loadApi();
  const failed = await api.getVodComments('123');
  assert.equal(failed.comments.length, 0);
  const [first, second] = await Promise.all([api.getVodComments('123'), api.getVodComments('123')]);
  assert.equal(calls, 2);
  assert.equal(first.comments, second.comments);
  assert.equal(first.comments.length, 1);
  await api.getVodComments('123', { contentOffsetSeconds: 80 });
  assert.equal(calls, 2);
});

test('archive fallback retains data after a failed refresh and excludes unpublished videos', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: true, json: async () => [
    { id: 'visible', youtube: [] }, { id: 'hidden', unpublished: true, youtube: [] },
  ] });
  const api = await loadApi();
  assert.equal((await api.findVodsStatic({})).total, 1);
  await assert.rejects(api.getVodById('hidden'), /unpublished/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await api.getVodById('visible', { forceRefresh: true })).id, 'visible');
});

for (const resource of ['emotes', 'badges']) {
  for (const failure of ['http', 'network']) {
    test(`${resource} readers share downloads and recover after ${failure} failure`, async (t) => {
      const originalFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = originalFetch; });
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        if (calls === 1) {
          if (failure === 'network') throw new Error('offline');
          return { ok: false, status: 503 };
        }
        return { ok: true, json: async () => resource === 'emotes'
          ? { ffz_emotes: [{ id: 'hello', name: 'Hello' }] }
          : { global: [{ id: 'moderator' }] } };
      };
      const api = await loadApi();
      const read = () => resource === 'emotes' ? api.getEmotes('123') : api.getBadges();
      const entries = result => resource === 'emotes' ? result.data[0].ffz_emotes : result.global;
      assert.equal(entries(await read()).length, 0);
      const [first, second] = await Promise.all([read(), read()]);
      assert.equal(entries(first).length, 1);
      assert.equal(entries(first), entries(second));
      assert.equal(calls, 2);
      await read();
      assert.equal(calls, 2);
    });
  }
}

test('expired overrides stop masking canonical data even when metadata refresh fails', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    Date.now = originalNow;
  });
  let now = 1_000_000;
  Date.now = () => now;
  let stored = JSON.stringify({ '123': { unpublished: true, savedAt: now } });
  globalThis.window = { localStorage: {
    getItem: () => stored,
    setItem: (_, value) => { stored = value; },
  } };
  globalThis.fetch = async () => ({ ok: true, json: async () => [{
    id: '123', unpublished: false, vodNotice: 'Original notice', chatReplayAvailable: true,
  }] });
  const api = await loadApi();
  assert.equal((await api.findVodsStatic()).total, 0);
  now += 29 * 60 * 1000;
  await assert.rejects(api.getVodById('123'), /unpublished/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  now += 2 * 60 * 1000;
  assert.equal((await api.findVodsStatic()).total, 1);
  assert.equal((await api.getVodById('123')).unpublished, false);
  assert.deepEqual(JSON.parse(stored), {});

  api.cacheLocalVodOverrideFromVod({ id: '123', vodNotice: 'Local edit', chatReplayAvailable: false });
  assert.equal((await api.getVodById('123')).vodNotice, 'Local edit');
  now += 31 * 60 * 1000;
  const restored = await api.getVodById('123');
  assert.equal(restored.vodNotice, 'Original notice');
  assert.equal(restored.chatReplayAvailable, true);
});

test('hidden parts retain their original timeline while visible parts keep ordinal navigation', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: true, json: async () => [{
    id: '123', duration: '00:04:50', youtube: [
      { id: 'first', part: 1, adminOrder: 1, duration: 100, unpublished: true },
      { id: 'second', part: 1, adminOrder: 2, duration: 100 },
      { id: 'third', part: 2, adminOrder: 3, duration: 50 },
    ],
  }] });
  const api = await loadApi();
  const vod = await api.getVodById('123');
  assert.deepEqual(vod.youtube.map(part => [part.id, part.part, part.timelineStartSeconds]), [
    ['second', 1, 140], ['third', 2, 240],
  ]);
});
