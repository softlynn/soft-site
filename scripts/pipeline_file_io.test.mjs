import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshotWriter, serializeFileUpdate, writeJsonFileAtomic } from "./pipeline_file_io.mjs";

test("a burst of progress snapshots waits for the current write and persists only the latest pending state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-snapshots-"));
  let release;
  const heldWrite = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let writes = 0;
  const file = path.join(dir, "state.json");
  const persist = createSnapshotWriter(async (snapshot) => {
    writes++;
    if (writes === 1) { started(); await heldWrite; }
    await writeJsonFileAtomic(file, snapshot);
  });
  try {
    const first = persist({ stage: "uploading", percent: 1 });
    await firstStarted;
    const pending = [];
    for (let percent = 2; percent < 100; percent++) pending.push(persist({ stage: "uploading", percent }));
    pending.push(persist({ stage: "complete", percent: 100 }));
    const concurrentWrites = writes;
    release();
    await Promise.all([first, ...pending]);
    assert.equal(concurrentWrites, 1, "progress writes overlapped the outstanding disk write");
    assert.equal(writes, 2, "intermediate snapshots were not coalesced");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { stage: "complete", percent: 100 });
  } finally {
    release();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a rejected file update does not poison subsequent writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-write-recovery-"));
  const file = path.join(dir, "state.json");
  try {
    await assert.rejects(serializeFileUpdate(file, async () => { throw new Error("disk busy"); }), /disk busy/);
    await serializeFileUpdate(file, () => writeJsonFileAtomic(file, { recovered: true }));
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { recovered: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failed snapshot is reported and the writer accepts a later retry", async () => {
  let fail = true;
  let stored;
  const persist = createSnapshotWriter(async (snapshot) => {
    if (fail) throw new Error("disk busy");
    stored = snapshot;
  });
  await assert.rejects(persist({ percent: 1 }), /disk busy/);
  fail = false;
  await persist({ percent: 2 });
  assert.deepEqual(stored, { percent: 2 });
});
