import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUploadSessionStore } from './upload_session_store.mjs';

test('upload checkpoints survive restart, separate sources and clear explicitly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-upload-session-'));
  try {
    const store = createUploadSessionStore(dir, '/recordings/one.mkv');
    assert.equal(await store.load(), null);
    const snapshot = { version: 1, url: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=private-fixture', confirmedBytes: 8192 };
    await store.save(snapshot);
    assert.deepEqual(await createUploadSessionStore(dir, '/recordings/one.mkv').load(), snapshot);
    assert.equal(await createUploadSessionStore(dir, '/recordings/two.mkv').load(), null);
    assert.ok((await fs.readdir(dir)).every(name => /^[a-f0-9]{64}\.json$/.test(name)));
    await store.save(null);
    assert.equal(await store.load(), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a corrupt checkpoint fails closed instead of starting a duplicate upload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-upload-corrupt-'));
  try {
    const store = createUploadSessionStore(dir, '/recordings/one.mkv');
    await store.save({ version: 1 });
    const [name] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, name), '{private-broken-session');
    await assert.rejects(store.load(), error => error.code === 'SOFTUCHIVE_UPLOAD_SESSION_UNREADABLE' && !error.message.includes('private-broken-session'));
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), '{private-broken-session');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a failed disk flush cannot acknowledge or replace a newer upload checkpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-upload-session-flush-'));
  const originalOpen = fs.open;
  try {
    const store = createUploadSessionStore(dir, '/recordings/one.mkv');
    const previous = { version: 1, confirmedBytes: 8, finalAttempted: false };
    await store.save(previous);
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (path.dirname(String(args[0])) === dir && String(args[0]).endsWith('.tmp')) {
        handle.sync = async () => { throw Object.assign(new Error('fixture disk flush failure'), { code: 'EIO' }); };
      }
      return handle;
    };
    await assert.rejects(store.save({ version: 1, confirmedBytes: 16, finalAttempted: true }), { code: 'EIO' });
    assert.deepEqual(await store.load(), previous);
    assert.equal((await fs.readdir(dir)).length, 1);
  } finally {
    fs.open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
