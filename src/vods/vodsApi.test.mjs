import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let moduleId = 0;
const loadApi = async () => {
  const source = (await readFile(new URL('../api/vodsApi.js', import.meta.url), 'utf8'))
    .replace('import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";', 'const USE_STATIC_ARCHIVE = true; const VODS_API_BASE = "";');
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// isolated test ${moduleId++}`).toString('base64')}`);
};

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
