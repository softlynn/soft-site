import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createArchiveSnapshotStore, mergeArchiveSnapshots, updateArchiveDatabase } from './archive_database.mjs';

test('a stale pipeline snapshot preserves admin flags and concurrently appended parts', () => {
  const base = [{ id: '1', title: 'stream', hidden: false, youtube: [{ id: 'a', part: 1, unpublished: false }] }];
  const proposed = structuredClone(base);
  proposed[0].title = 'finished stream';
  proposed[0].youtube.push({ id: 'b', part: 2 });
  const latest = structuredClone(base);
  latest[0].hidden = true;
  latest[0].youtube[0].unpublished = true;
  latest.push({ id: '2', title: 'another stream' });
  const merged = mergeArchiveSnapshots(base, proposed, latest);
  assert.equal(merged[0].title, 'finished stream');
  assert.equal(merged[0].hidden, true);
  assert.deepEqual(merged[0].youtube, [{ id: 'a', part: 1, unpublished: true }, { id: 'b', part: 2 }]);
  assert.equal(merged[1].id, '2');
  assert.deepEqual(base[0].youtube, [{ id: 'a', part: 1, unpublished: false }]);
});

test('conflicting edits prefer the freshest value and deleted records are not resurrected', () => {
  const base = [{ id: '1', title: 'old' }, { id: '2', title: 'deleted' }];
  const proposed = [{ id: '1', title: 'pipeline' }, { id: '2', title: 'deleted' }, { id: '3', title: 'new' }];
  const latest = [{ id: '1', title: 'admin' }];
  assert.deepEqual(mergeArchiveSnapshots(base, proposed, latest), [{ id: '1', title: 'admin' }, { id: '3', title: 'new' }]);
});

test('successive pipeline saves never undo an admin edit absent from its local snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-snapshot-'));
  const file = path.join(dir, 'vods.json');
  try {
    await fs.writeFile(file, JSON.stringify([{ id: '1', hidden: false, youtube: [] }]));
    const store = createArchiveSnapshotStore(file);
    const rows = await store.read();
    await updateArchiveDatabase(file, current => { current[0].hidden = true; return current; });
    rows[0].youtube.push({ id: 'a' });
    await store.write(rows);
    rows[0].youtube.push({ id: 'b' });
    await store.write(rows);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: '1', hidden: true, youtube: [{ id: 'a' }, { id: 'b' }] }]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('overlapping snapshot saves retain the latest requested changes when the first lock is delayed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-save-order-'));
  const file = path.join(dir, 'vods.json');
  const originalRename = fs.rename;
  let signalFirstAttempt, unblockFirst;
  const firstAttempt = new Promise(resolve => { signalFirstAttempt = resolve; });
  const gate = new Promise(resolve => { unblockFirst = resolve; });
  let firstSeen = false;
  try {
    await fs.writeFile(file, JSON.stringify([{ id: '1', title: 'original' }]));
    const store = createArchiveSnapshotStore(file);
    const rows = await store.read();
    fs.rename = async (...args) => {
      if (args[1] === `${file}.lock` && !firstSeen) {
        firstSeen = true;
        signalFirstAttempt();
        await gate;
      }
      return originalRename(...args);
    };
    rows[0].title = 'first';
    const earlier = store.write(rows);
    await firstAttempt;
    rows[0].title = 'latest';
    rows.push({ id: '2' });
    const later = store.write(rows);
    await Promise.race([later, new Promise(resolve => setTimeout(resolve, 80))]);
    unblockFirst();
    await Promise.all([earlier, later]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: '1', title: 'latest' }, { id: '2' }]);
  } finally {
    unblockFirst();
    fs.rename = originalRename;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed snapshot save does not reject the next queued save or advance its baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-save-failure-'));
  const file = path.join(dir, 'vods.json');
  const originalRename = fs.rename;
  let failedOnce = false;
  try {
    await fs.writeFile(file, '[]');
    const store = createArchiveSnapshotStore(file);
    const rows = await store.read();
    fs.rename = async (...args) => {
      if (args[1] === file && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      }
      return originalRename(...args);
    };
    rows.push({ id: '1' });
    const rejected = assert.rejects(store.write(rows), { code: 'EIO' });
    rows.push({ id: '2' });
    const recovered = store.write(rows);
    await Promise.all([rejected, recovered]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: '1' }, { id: '2' }]);
  } finally {
    fs.rename = originalRename;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maintenance waits for an earlier snapshot save before transforming its records', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-mutation-order-'));
  const file = path.join(dir, 'vods.json');
  const originalRename = fs.rename;
  let signalFirstAttempt, unblockFirst;
  const firstAttempt = new Promise(resolve => { signalFirstAttempt = resolve; });
  const gate = new Promise(resolve => { unblockFirst = resolve; });
  let firstSeen = false;
  try {
    await fs.writeFile(file, '[]');
    const store = createArchiveSnapshotStore(file);
    const rows = await store.read();
    fs.rename = async (...args) => {
      if (args[1] === `${file}.lock` && !firstSeen) {
        firstSeen = true;
        signalFirstAttempt();
        await gate;
      }
      return originalRename(...args);
    };
    rows.push({ id: '1' });
    const save = store.write(rows);
    await firstAttempt;
    const mutation = store.mutate(rows, current => current.map(row => ({ ...row, maintained: true })));
    await Promise.race([mutation, new Promise(resolve => setTimeout(resolve, 80))]);
    unblockFirst();
    await Promise.all([save, mutation]);
    assert.deepEqual(rows, [{ id: '1', maintained: true }]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), rows);
  } finally {
    unblockFirst();
    fs.rename = originalRename;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maintenance uses current records atomically and refreshes the caller snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-maintenance-'));
  const file = path.join(dir, 'vods.json');
  try {
    await fs.writeFile(file, JSON.stringify([{ id: '1', hidden: false }]));
    const store = createArchiveSnapshotStore(file);
    const rows = await store.read();
    await updateArchiveDatabase(file, current => { current[0].hidden = true; return current; });
    await store.mutate(rows, current => { assert.equal(current[0].hidden, true); current.push({ id: '2' }); return current; });
    assert.deepEqual(rows, [{ id: '1', hidden: true }, { id: '2' }]);
    rows[0].title = 'after maintenance';
    await store.write(rows);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].hidden, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('independent processes serialize complete read-modify-write transactions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-store-'));
  const file = path.join(dir, 'vods.json');
  const moduleUrl = new URL('./archive_database.mjs', import.meta.url).href;
  try {
    await fs.writeFile(file, JSON.stringify([{ id: '1', count: 0 }]));
    const script = `import { updateArchiveDatabase } from ${JSON.stringify(moduleUrl)};
      for (let i=0;i<8;i++) await updateArchiveDatabase(process.argv[1], async rows => {
        const count=rows[0].count; await new Promise(r=>setTimeout(r,5));
        rows[0].count=count+1; return rows;
      });`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)));
    })));
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].count, 32);
    assert.deepEqual(await fs.readdir(dir), ['vods.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a rejected update releases ownership and corrupt data is never replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-failure-'));
  const file = path.join(dir, 'vods.json');
  try {
    await assert.rejects(updateArchiveDatabase(file, () => { throw new Error('stop'); }), /stop/);
    await updateArchiveDatabase(file, () => [{ id: '1' }]);
    await fs.writeFile(file, '{broken');
    await assert.rejects(updateArchiveDatabase(file, () => []), /JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    assert.deepEqual(await fs.readdir(dir), ['vods.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an abandoned local owner is reclaimed without treating a foreign host as dead', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-stale-'));
  const file = path.join(dir, 'vods.json');
  const lock = `${file}.lock`;
  try {
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner-stale.json'), JSON.stringify({ pid: 2147483647, hostname: os.hostname() }));
    await updateArchiveDatabase(file, () => [{ id: 'recovered' }]);
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner-remote.json'), JSON.stringify({ pid: 2147483647, hostname: 'a-different-worker' }));
    await assert.rejects(updateArchiveDatabase(file, () => [], { timeoutMs: 60 }), /busy/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].id, 'recovered');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an empty lock left by a process exiting during release is reclaimed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft-archive-empty-lock-'));
  const file = path.join(dir, 'vods.json');
  try {
    await fs.mkdir(`${file}.lock`);
    await updateArchiveDatabase(file, () => [{ id: 'recovered' }], { timeoutMs: 80 });
    assert.deepEqual(await fs.readdir(dir), ['vods.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
