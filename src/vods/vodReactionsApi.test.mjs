import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let moduleId = 0;
const loadApi = async () => {
  const source = await readFile(new URL('./vodReactionsApi.js', import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// isolated ${moduleId++}`).toString('base64')}`);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('concurrent cards share discovery while each receives its own primary count', async (t) => {
  let healthReads = 0;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    requests.push(url);
    if (url.endsWith('/_health')) {
      healthReads++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return json({ ok: true });
    }
    return json({ likes: Number(url.split('/').at(-1)), dislikes: 2 });
  });
  const api = await loadApi();
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map(id => api.getVodLikeCount(id))), [1, 2, 3, 4]);
  assert.equal(healthReads, 1);
  assert.equal(requests.length, 5);
  assert.equal((await api.getVodReactionSnapshot('5')).dislikes, 2);
  assert.equal(healthReads, 1, 'completed discovery remains cached');
});

test('failed shared discovery retains legacy like-only reads and can recover after mode expiry', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let healthy = false;
  let healthReads = 0;
  const legacyReads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    if (url.endsWith('/_health')) {
      healthReads++;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (!healthy) throw new Error('offline');
      return json({ ok: true });
    }
    if (url.startsWith('https://api.counterapi.dev/')) {
      legacyReads.push(url);
      assert.ok(url.endsWith('-like'), 'card reads must not request legacy dislikes or mutations');
      return json({ count: 7 });
    }
    return json({ likes: 11, dislikes: 3 });
  });
  const api = await loadApi();
  assert.deepEqual(await Promise.all([api.getVodLikeCount('a'), api.getVodLikeCount('b')]), [7, 7]);
  assert.equal(healthReads, 1);
  assert.equal(legacyReads.length, 2);
  healthy = true;
  now += 6 * 60 * 1000;
  assert.equal(await api.getVodLikeCount('c'), 11);
  assert.equal(healthReads, 2, 'settled discovery must not prevent a later retry');
});
