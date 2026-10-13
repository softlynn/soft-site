import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.REACT_APP_REACTIONS_API_BASE = 'https://reactions.test/v1/reactions/';
const API_BASE = 'https://reactions.test/v1/reactions';
const VOTE_STORAGE_KEY = 'softu-vod-reaction-votes-v1';

let moduleId = 0;
const loadApi = async () => {
  const source = await readFile(new URL('./vodReactionsApi.js', import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// isolated ${moduleId++}`).toString('base64')}`);
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const flush = () => new Promise(resolve => setImmediate(resolve));
// Drives a promise whose retries wait on mocked setTimeout timers to settlement.
const settle = async (t, promise) => {
  let settled = false;
  const tracked = promise.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  for (let i = 0; i < 20 && !settled; i++) {
    await flush();
    if (!settled) t.mock.timers.runAll();
  }
  assert.ok(settled, 'promise must settle once every pending timer has fired');
  return tracked;
};
const installLocalStorage = (t, seed = {}) => {
  const storage = new Map(Object.entries(seed));
  globalThis.window = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  } };
  t.after(() => { delete globalThis.window; });
  return storage;
};

test('reads come from the Worker only, shared in flight and cached until the TTL expires', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    requests.push(url);
    return json({ likes: Number(url.split('/').at(-1)), dislikes: 2 });
  });
  const api = await loadApi();
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map(id => api.getVodLikeCount(id))), [1, 2, 3, 4]);
  assert.deepEqual(requests, [1, 2, 3, 4].map(id => `${API_BASE}/${id}`), 'one Worker read per card and no health probe');

  const [likes, snapshot] = await Promise.all([api.getVodLikeCount('5'), api.getVodReactionSnapshot('5')]);
  assert.deepEqual([likes, snapshot.likes, snapshot.dislikes], [5, 5, 2]);
  assert.equal(requests.length, 5, 'concurrent reads of one VOD share a request');

  assert.equal(await api.getVodLikeCount('5'), 5);
  assert.equal(requests.length, 5, 'fresh snapshots are served from the cache');
  now += 3 * 60 * 1000;
  assert.equal((await api.getVodReactionSnapshot('5')).likes, 5);
  assert.equal(requests.length, 6, 'expired snapshots are read again');
});

test('a rate-limited read waits for Retry-After before retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return attempts === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '2' }) : json({ likes: 3, dislikes: 1 });
  });
  const api = await loadApi();
  const pending = api.getVodReactionSnapshot('rate-limited');
  await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(attempts, 1, 'the retry honours Retry-After');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(attempts, 2);
  const snapshot = await pending;
  assert.deepEqual([snapshot.likes, snapshot.dislikes], [3, 1]);
});

test('an unreachable Worker rejects reads after retrying, without contacting any other host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    throw new TypeError('Failed to fetch');
  });
  const api = await loadApi();
  const { error } = await settle(t, api.getVodReactionSnapshot('offline'));
  assert.equal(error?.message, 'Failed to fetch');
  assert.deepEqual(requests, Array(3).fill(`${API_BASE}/offline`), 'retries stay on the Worker');

  const { value } = await settle(t, api.getVodLikeCount('offline').catch(() => 'rejected'));
  assert.equal(value, 'rejected', 'a failed read is not cached');
  assert.equal(requests.length, 6);
});

test('a failed vote rejects after reverting the optimistic snapshot and the stored vote', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = installLocalStorage(t, { [VOTE_STORAGE_KEY]: JSON.stringify({ 'older-vod': 'dislike' }) });
  let workerUp = false;
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'GET') return json({ likes: 5, dislikes: 1 });
    assert.equal(options.method, 'POST');
    posts.push({ url, body: JSON.parse(options.body) });
    if (!workerUp) throw new TypeError('Failed to fetch');
    return json({ likes: 6, dislikes: 1 });
  });
  const api = await loadApi();
  assert.equal(api.getStoredVodReactionVote('older-vod'), 'dislike', 'persisted votes are restored from localStorage');
  const seen = [];
  api.subscribeVodReactionSnapshot('vod-1', snapshot => seen.push([snapshot.likes, snapshot.dislikes]));
  await api.getVodReactionSnapshot('vod-1');

  const { error } = await settle(t, api.setVodReactionVote('vod-1', 'like', null));
  assert.equal(error?.message, 'Failed to fetch');
  assert.equal(posts.length, 3, 'the Worker write is retried before giving up');
  assert.ok(posts.every(post => post.url === `${API_BASE}/vod-1`), 'writes never leave the Worker');
  assert.deepEqual(posts[0].body, { nextVote: 'like', previousVote: null });
  assert.deepEqual(seen, [[5, 1], [6, 1], [5, 1]], 'subscribers see the optimistic count and its revert');
  assert.equal(api.getStoredVodReactionVote('vod-1'), null, 'the stored vote is reverted');
  assert.deepEqual(JSON.parse(storage.get(VOTE_STORAGE_KEY)), { 'older-vod': 'dislike' });

  workerUp = true;
  const saved = await api.setVodReactionVote('vod-1', 'like', null);
  assert.deepEqual([saved.likes, saved.dislikes], [6, 1]);
  assert.deepEqual(seen.at(-1), [6, 1]);
  assert.equal(api.getStoredVodReactionVote('vod-1'), 'like');
  assert.deepEqual(JSON.parse(storage.get(VOTE_STORAGE_KEY)), { 'older-vod': 'dislike', 'vod-1': 'like' });
});
