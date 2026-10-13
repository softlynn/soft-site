import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const source = await fs.readFile(new URL("./index.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const schema = await fs.readFile(new URL("../schema.sql", import.meta.url), "utf8");

const fixture = (t, extraEnv = {}) => {
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
  }, ...extraEnv };
  const started = Date.now();
  const request = (path, init) => worker.fetch(new Request(`https://fixture.invalid${path}`, init), env);
  const report = async (patch, secret = env.UPLOAD_STATUS_WRITE_SECRET) => {
    const response = await request("/v1/uploads/report", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Status-Secret": secret },
      body: JSON.stringify({ sessionId: "fixture-session", twitchVodId: "fixture-vod", partNumber: 1,
        createdAtMs: started, updatedAtMs: started, state: "preparing", ...patch }),
    });
    return { status: response.status, ...await response.json() };
  };
  const active = async () => {
    const response = await request("/v1/uploads/active");
    assert.equal(response.status, 200);
    return (await response.json()).uploads;
  };
  const vote = async (vodId, body, init = {}) => {
    const response = await request(`/v1/reactions/${vodId}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...init.headers }, body: JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, ...await response.json() };
  };
  return { request, report, active, vote, started, sqlite, env };
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
  assert.equal((await report({ state: "done", sessionId: "has whitespace" })).status, 400);
  const rows = await active();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "uploading");
  assert.equal(rows[0].percent, 25);
});

test("public polling never writes; expired rows are pruned by the pipeline's next report", async (t) => {
  const { report, active, sqlite, started } = fixture(t);
  await report({ state: "uploading", updatedAtMs: started + 10 });
  const count = () => sqlite.prepare("SELECT COUNT(*) AS rows FROM vod_upload_sessions").get().rows;
  sqlite.prepare("INSERT INTO vod_upload_sessions (session_id, state, created_at_ms, updated_at_ms, expires_at_ms) VALUES ('expired', 'done', 1, 1, 1)").run();
  assert.equal(count(), 2);
  assert.deepEqual((await active()).map((session) => session.sessionId), ["fixture-session"]);
  assert.equal(count(), 2, "a public read deleted rows");
  await report({ state: "uploading", percent: 10, updatedAtMs: started + 20 });
  assert.equal(count(), 1, "the authenticated write did not prune the expired row");
});

test("the active list is served from a short cache that pipeline reports invalidate", async (t) => {
  const { report, active, sqlite, started } = fixture(t);
  await report({ state: "uploading", percent: 10, updatedAtMs: started + 10 });
  assert.equal((await active())[0].percent, 10);
  sqlite.prepare("UPDATE vod_upload_sessions SET percent = 55").run();
  assert.equal((await active())[0].percent, 10, "a repeat poll went back to the database");
  await report({ state: "uploading", percent: 60, updatedAtMs: started + 20 });
  assert.equal((await active())[0].percent, 60);
});

test("reaction votes are applied in one statement and never drop below zero", async (t) => {
  const { request, vote } = fixture(t);
  const empty = await (await request("/v1/reactions/12345")).json();
  assert.deepEqual(empty, { vodId: "12345", likes: 0, dislikes: 0, updatedAt: null });
  assert.equal((await vote("12345", { previousVote: null, nextVote: "like" })).likes, 1);
  assert.equal((await vote("12345", { previousVote: "like", nextVote: "dislike" })).likes, 0);
  const switched = await vote("12345", { previousVote: "like", nextVote: "dislike" });
  assert.deepEqual([switched.likes, switched.dislikes], [0, 2]);
  const cleared = await vote("12345", { previousVote: "dislike", nextVote: null });
  assert.deepEqual([cleared.likes, cleared.dislikes], [0, 1]);
  const stored = await (await request("/v1/reactions/12345")).json();
  assert.deepEqual([stored.likes, stored.dislikes], [0, 1]);
  assert.ok(stored.updatedAt);
});

test("malformed reaction requests are client errors that create no rows", async (t) => {
  const { request, sqlite } = fixture(t);
  const count = () => sqlite.prepare("SELECT COUNT(*) AS rows FROM vod_reactions").get().rows;
  const post = (path, body, headers = {}) => request(path, { method: "POST", headers, body });
  assert.equal((await post("/v1/reactions/not%20a%20vod", "{}")).status, 404);
  assert.equal((await post("/v1/reactions/%E0%A4%A", "{}")).status, 404);
  assert.equal((await post("/v1/reactions/12345", "{bad json")).status, 400);
  assert.equal((await post("/v1/reactions/12345", `{"pad":"${"x".repeat(20_000)}"}`)).status, 413);
  assert.equal((await post("/v1/reactions/12345", "{}", { "Content-Length": "999999" })).status, 413);
  assert.equal((await request("/v1/reactions/12345", { method: "DELETE" })).status, 405);
  assert.equal((await request("/v1/uploads/active", { method: "POST" })).status, 405);
  assert.equal((await request("/v1/uploads/unknown")).status, 404);
  assert.equal((await request("/v2/reactions/12345")).status, 404);
  assert.equal(count(), 0);
});

test("the rate limiting binding throttles anonymous writes and failed secrets only", async (t) => {
  const keys = [];
  let allow = true;
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: allow }; } };
  const { request, report, vote } = fixture(t, { REACTION_WRITE_LIMITER: limiter });
  const client = { headers: { "CF-Connecting-IP": "203.0.113.7" } };
  assert.equal((await vote("12345", { nextVote: "like" }, client)).status, 200);
  allow = false;
  const limited = await vote("12345", { nextVote: "like" }, client);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "10");
  assert.equal((await report({ state: "done" }, "wrong-secret")).status, 429);
  assert.equal((await report({ state: "uploading" })).status, 200, "the authenticated pipeline was throttled");
  assert.equal((await request("/v1/reactions/12345")).status, 200, "reads were throttled");
  assert.deepEqual(keys, ["203.0.113.7", "203.0.113.7", "anonymous"]);
});

test("CORS headers are only granted to allowed origins and internal failures stay private", async (t) => {
  const { request } = fixture(t, { ALLOWED_ORIGINS: "https://extra.example" });
  const allowed = await request("/v1/reactions/12345", { headers: { Origin: "https://softu.one" } });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://softu.one");
  assert.equal(allowed.headers.get("X-Content-Type-Options"), "nosniff");
  const extra = await request("/v1/reactions/12345", { method: "OPTIONS", headers: { Origin: "https://extra.example" } });
  assert.equal(extra.status, 204);
  assert.equal(extra.headers.get("Access-Control-Allow-Origin"), "https://extra.example");
  const denied = await request("/v1/reactions/12345", { headers: { Origin: "https://unrelated.example" } });
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);

  t.mock.method(console, "error", () => {});
  const broken = { UPLOAD_STATUS_WRITE_SECRET: "s", DB: { prepare() { throw new Error("D1_ERROR: internal table detail"); } } };
  const response = await worker.fetch(new Request("https://fixture.invalid/v1/reactions/12345"), broken);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error" });
});
