import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('upload polling keeps its timeout even when its caller supplies a cancellation signal', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = (await readFile(new URL('../api/uploadStatusApi.js', import.meta.url), 'utf8'))
    .replace('process.env.REACT_APP_UPLOADS_API_BASE', '"https://uploads.invalid"');
  const { fetchActiveVodUploads } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let networkSignal;
  globalThis.fetch = async (_, { signal }) => {
    networkSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = fetchActiveVodUploads({ signal: controller.signal });
  const timedOut = assert.rejects(pending, { name: 'AbortError' });
  t.mock.timers.tick(5000);
  assert.equal(networkSignal.aborted, true, 'a stalled visible poll must time out and allow future polls');
  await timedOut;
  assert.equal(controller.signal.aborted, false, 'the request must not abort its owner');

  const next = fetchActiveVodUploads({ signal: controller.signal });
  const canceled = assert.rejects(next, { name: 'AbortError' });
  controller.abort();
  await canceled;
  assert.equal(networkSignal.aborted, true, 'hiding the tab still cancels the active request');
});
