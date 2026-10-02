import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const source = await fs.readFile(new URL("./index.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const schema = await fs.readFile(new URL("../schema.sql", import.meta.url), "utf8");

const fixture = (t) => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  // Run the real Worker SQL against SQLite, exposing D1's small async facade.
  const env = { UPLOAD_STATUS_WRITE_SECRET: "fixture-secret", DB: {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const wrapper = (values = []) => ({
        bind: (...next) => wrapper(next),
        run: async () => statement.run(...values),
        first: async () => statement.get(...values) || null,
        all: async () => ({ results: statement.all(...values) }),
      });
      return wrapper();
    },
  } };
  const started = Date.now();
  const report = async (patch, secret = env.UPLOAD_STATUS_WRITE_SECRET) => {
    const response = await worker.fetch(new Request("https://fixture.invalid/v1/uploads/report", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Status-Secret": secret },
      body: JSON.stringify({ sessionId: "fixture-session", twitchVodId: "fixture-vod", partNumber: 1,
        createdAtMs: started, updatedAtMs: started, state: "preparing", ...patch }),
    }), env);
    return { status: response.status, ...await response.json() };
  };
  const active = async () => {
    const response = await worker.fetch(new Request("https://fixture.invalid/v1/uploads/active"), env);
    assert.equal(response.status, 200);
    return (await response.json()).uploads;
  };
  return { report, active, started, sqlite };
};

test("late and regressive reports cannot reopen a finished upload", async (t) => {
  const { report, active, started } = fixture(t);
  await report({ state: "uploading", percent: 50, updatedAtMs: started + 10 });
  const done = await report({ state: "done", percent: 100, youtubeVideoId: "fixture-youtube", updatedAtMs: started + 30 });
  assert.equal(done.status, 200);
  for (const updatedAtMs of [started + 20, started + 30, started + 40]) {
    const stale = await report({ state: "uploading", percent: 80, updatedAtMs });
    assert.equal(stale.status, 200);
    assert.equal(stale.session.state, "done");
    assert.equal(stale.session.percent, 100);
    assert.equal(stale.session.updatedAtMs, started + 30);
    assert.equal(stale.session.youtubeVideoId, "fixture-youtube");
  }
  assert.deepEqual(await active(), []);
});

test("older progress and regressive same-millisecond phases are ignored atomically", async (t) => {
  const { report, started } = fixture(t);
  await report({ state: "uploading", percent: 70, uploadedBytes: 700, updatedAtMs: started + 20 });
  const older = await report({ state: "uploading", percent: 30, uploadedBytes: 300, updatedAtMs: started + 10 });
  assert.equal(older.session.percent, 70);
  assert.equal(older.session.uploadedBytes, 700);
  await report({ state: "finalizing", percent: 99, updatedAtMs: started + 20 });
  const earlierStage = await report({ state: "uploading", percent: 90, updatedAtMs: started + 20 });
  assert.equal(earlierStage.session.state, "finalizing");
  assert.equal(earlierStage.session.percent, 99);
});

test("manual skip closes public progress and another session can resume the recording", async (t) => {
  const { report, active, started } = fixture(t);
  await report({ state: "uploading", updatedAtMs: started + 10 });
  const skipped = await report({ state: "skipped", updatedAtMs: started + 20 });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.session.state, "skipped");
  assert.deepEqual(await active(), []);
  const later = await report({ state: "uploading", updatedAtMs: started + 30 });
  assert.equal(later.session.state, "skipped");
  await report({ sessionId: "new-fixture-session", state: "uploading", createdAtMs: started + 40, updatedAtMs: started + 40 });
  assert.deepEqual((await active()).map((session) => session.sessionId), ["new-fixture-session"]);
});

test("unknown upload measurements remain null and updates preserve known values", async (t) => {
  const { report, started } = fixture(t);
  const unknown = await report({ state: "preparing", percent: null, uploadedBytes: null, totalBytes: null });
  assert.equal(unknown.session.percent, null);
  assert.equal(unknown.session.uploadedBytes, null);
  assert.equal(unknown.session.totalBytes, null);
  await report({ state: "uploading", uploadedBytes: 80, totalBytes: 100, percent: 80, updatedAtMs: started + 10 });
  const paused = await report({ state: "paused", percent: null, uploadedBytes: null, totalBytes: null, updatedAtMs: started + 20 });
  assert.equal(paused.session.percent, 80);
  assert.equal(paused.session.uploadedBytes, 80);
  assert.equal(paused.session.totalBytes, 100);
});

test("rejected writes cannot mutate existing upload state", async (t) => {
  const { report, active } = fixture(t);
  await report({ state: "uploading", percent: 25 });
  assert.equal((await report({ state: "done" }, "wrong-fixture-secret")).status, 401);
  assert.equal((await report({ state: "invalid" })).status, 400);
  const rows = await active();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "uploading");
  assert.equal(rows[0].percent, 25);
});
