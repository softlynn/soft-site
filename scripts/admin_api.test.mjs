import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireArchiveFileLock } from "./archive_database.mjs";
import { writeJsonFileAtomic } from "./pipeline_file_io.mjs";

async function startFixture(t, { vods = [{ id: "test-vod", title: "Synthetic fixture", chatReplayAvailable: true }], privacy = "public", autoGitPush = false, beforeStart } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "soft-admin-api-"));
  const vodsPath = path.join(directory, "vods.json");
  await fs.mkdir(path.join(directory, "scripts"));
  for (const name of ["run_local_admin_api.mjs", "admin_console.mjs", "pipeline_file_io.mjs", "archive_database.mjs"]) {
    await fs.copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(directory, "scripts", name));
  }
  await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true }).status, 0);
  await fs.writeFile(vodsPath, JSON.stringify(vods));
  await fs.writeFile(path.join(directory, "client.json"), JSON.stringify({ installed: { client_id: "fixture", client_secret: "fixture", redirect_uris: ["http://localhost"] } }));
  await fs.writeFile(path.join(directory, "token.json"), "{}");
  await fs.writeFile(path.join(directory, "google-fixture.mjs"), `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const root = ${JSON.stringify(directory)};
    export const google = {
      auth: { OAuth2: class { setCredentials() {} } },
      youtube: () => ({ videos: {
        list: async ({ id }) => ({ data: { items: [{ id: id[0], status: { privacyStatus: ${JSON.stringify(privacy)} } }] } }),
        update: async ({ requestBody }) => {
          await fs.writeFile(path.join(root, "youtube-started.json"), JSON.stringify(requestBody));
          while (!await fs.access(path.join(root, "youtube-release")).then(() => true, () => false)) await delay(10);
          return { data: requestBody };
        },
      } }),
    };
  `);
  await fs.writeFile(path.join(directory, "fixture-hooks.mjs"), `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "googleapis") return { url: ${JSON.stringify(pathToFileURL(path.join(directory, "google-fixture.mjs")).href)}, shortCircuit: true };
      return nextResolve(specifier, context);
    } });
  `);
  if (beforeStart) await beforeStart({ directory, vodsPath });
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(directory, "fixture-hooks.mjs")).href, path.join(directory, "scripts", "run_local_admin_api.mjs")], {
    windowsHide: true,
    env: { ...process.env, ADMIN_API_HOST: "127.0.0.1", ADMIN_API_PORT: "0", ADMIN_PANEL_PASSWORD: "fixture-password",
      AUTO_GIT_PUSH: String(autoGitPush), ARCHIVE_VODS_PATH: vodsPath, SITE_DESIGN_PATH: path.join(directory, "design.json"),
      SITE_DESIGN_ASSETS_PATH: path.join(directory, "assets"), ADMIN_API_IDLE_TIMEOUT_MINUTES: "0",
      YOUTUBE_CLIENT_SECRET_PATH: path.join(directory, "client.json"), YOUTUBE_TOKEN_PATH: path.join(directory, "token.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture server did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture server exited: ${code}`)); });
  });
  const auth = await fetch(`${base}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "fixture-password" }) });
  assert.equal(auth.status, 200);
  const { token } = await auth.json();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return { base, headers, directory, vodsPath };
}

test("real admin login, concurrent flags, and local console stay consistent", async (t) => {
  const { base, headers } = await startFixture(t);
  assert.equal((await fetch(`${base}/session`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { Origin: "https://unrelated.example" } })).status, 403);
  const changes = await Promise.all([
    fetch(`${base}/vods/test-vod/notice`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) }),
    fetch(`${base}/vods/test-vod/chat-replay`, { method: "POST", headers, body: JSON.stringify({ available: false }) }),
  ]);
  const outcomes = await Promise.all(changes.map(async (response) => ({ status: response.status, body: await response.json() })));
  assert.deepEqual(outcomes.map((response) => response.status), [200, 200], JSON.stringify(outcomes));
  const { vods } = await (await fetch(`${base}/vods`, { headers })).json();
  assert.ok(vods[0].vodNotice);
  assert.equal(vods[0].chatReplayAvailable, false);
  const unpublished = await fetch(`${base}/vods/test-vod/unpublish`, { method: "POST", headers });
  assert.equal(unpublished.status, 200, JSON.stringify(await unpublished.clone().json()));
  assert.equal((await unpublished.json()).result.twitch.changed, false);
  const republished = await fetch(`${base}/vods/test-vod/republish`, { method: "POST", headers });
  assert.equal(republished.status, 200);
  const secondAuth = await fetch(`${base}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "fixture-password" }) });
  const secondToken = (await secondAuth.json()).token;
  assert.equal((await fetch(`${base}/logout`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/logout`, { method: "POST", headers })).status, 200);
  assert.equal((await fetch(`${base}/session`, { headers })).status, 401, "signed out token was still accepted");
  assert.equal((await fetch(`${base}/vods/test-vod/notice`, { method: "POST", headers, body: JSON.stringify({ enabled: false }) })).status, 401);
  assert.equal((await fetch(`${base}/session`, { headers: { Authorization: `Bearer ${secondToken}` } })).status, 200, "sign out revoked another tab's session");
});

test("admin updates wait for a separate archive writer and preserve its new rows", async (t) => {
  const { base, headers, vodsPath } = await startFixture(t);
  const release = await acquireArchiveFileLock(vodsPath);
  let released = false;
  t.after(async () => { if (!released) await release(); });
  const pending = fetch(`${base}/vods/test-vod/notice`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
  // The competing writer owns the file until its latest snapshot is published.
  await delay(100);
  const during = JSON.parse(await fs.readFile(vodsPath, "utf8"));
  assert.equal(during[0].vodNotice, undefined, "admin bypassed the archive writer's ownership");
  await writeJsonFileAtomic(vodsPath, [{ ...during[0], title: "Fresh pipeline title" }, { id: "new-vod" }]);
  await release();
  released = true;
  const response = await pending;
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = JSON.parse(await fs.readFile(vodsPath, "utf8"));
  assert.equal(saved[0].title, "Fresh pipeline title");
  assert.ok(saved[0].vodNotice);
  assert.equal(saved[1].id, "new-vod");
});

for (const action of ["unpublish", "republish"]) {
  test(`${action} part preserves parts and metadata added while YouTube is responding`, async (t) => {
    const hiding = action === "unpublish";
    const { base, headers, directory, vodsPath } = await startFixture(t, {
      privacy: hiding ? "public" : "private",
      vods: [{ id: "test-vod", youtube: [
        { id: "video-one", part: 1, adminOrder: 1 },
        { id: "video-two", part: 2, adminOrder: 2 },
        { id: "video-three", part: 3, adminOrder: 3, unpublished: true },
      ] }],
    });
    const request = fetch(`${base}/vods/test-vod/parts/${hiding ? "1" : "video-three"}/${action}`, { method: "POST", headers });
    const startedPath = path.join(directory, "youtube-started.json");
    const deadline = Date.now() + 5000;
    while (!await fs.access(startedPath).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, "YouTube fixture was not reached");
      await delay(10);
    }
    const [latest] = JSON.parse(await fs.readFile(vodsPath, "utf8"));
    latest.vodNotice = "Keep this latest notice";
    latest.youtube[1].title = "A title updated during the request";
    latest.youtube.push({ id: "video-four", part: 4, adminOrder: 4 });
    await fs.writeFile(vodsPath, JSON.stringify([latest, { id: "new-vod", title: "Another archived stream" }]));
    await fs.writeFile(path.join(directory, "youtube-release"), "ready");
    const response = await request;
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.vod.vodNotice, "Keep this latest notice");
    assert.equal(payload.vod.youtube.find((part) => part.id === "video-two").title, "A title updated during the request");
    assert.ok(payload.vod.youtube.some((part) => part.id === "video-four"), "concurrent appended part was lost");
    assert.equal(payload.vod.youtube.find((part) => part.id === (hiding ? "video-one" : "video-three")).unpublished, hiding);
    const saved = JSON.parse(await fs.readFile(vodsPath, "utf8"));
    assert.ok(saved.some((vod) => vod.id === "new-vod"));
    assert.deepEqual(payload.vod.youtube.filter((part) => !part.unpublished).map((part) => part.part), hiding ? [1, 2] : [1, 2, 3, 4]);
  });
}

const gitFixture = (cwd, args) => {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("publishing an admin flag preserves remote-only VODs and parts and reconciles them locally", async (t) => {
  let origin;
  const { base, headers, directory, vodsPath } = await startFixture(t, {
    autoGitPush: true,
    vods: [{ id: "test-vod", chatReplayAvailable: true, youtube: [{ id: "original-part", part: 1 }] }, { id: "local-only" }],
    beforeStart: async ({ directory, vodsPath }) => {
      gitFixture(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      gitFixture(directory, ["add", "vods.json"]);
      gitFixture(directory, ["commit", "--quiet", "-m", "Fixture baseline"]);
      origin = path.join(directory, "origin.git");
      gitFixture(directory, ["init", "--bare", "--quiet", "--initial-branch=main", origin]);
      gitFixture(directory, ["remote", "add", "origin", origin]);
      gitFixture(directory, ["push", "--quiet", "-u", "origin", "main"]);
      const remoteClient = path.join(directory, "remote-client");
      gitFixture(directory, ["clone", "--quiet", origin, remoteClient]);
      const rows = JSON.parse(await fs.readFile(vodsPath, "utf8"));
      rows[0].youtube.push({ id: "remote-part", part: 2 });
      rows.push({ id: "remote-only", title: "Remote stream" });
      await fs.writeFile(path.join(remoteClient, "vods.json"), JSON.stringify(rows));
      gitFixture(remoteClient, ["add", "vods.json"]);
      gitFixture(remoteClient, ["commit", "--quiet", "-m", "Remote additions"]);
      gitFixture(remoteClient, ["push", "--quiet", "origin", "main"]);
      const localRows = JSON.parse(await fs.readFile(vodsPath, "utf8"));
      localRows.push({ id: "not-yet-published-local" });
      localRows[0].youtube.push({ id: "not-yet-published-part", part: 2 });
      await fs.writeFile(vodsPath, JSON.stringify(localRows));
    },
  });
  const response = await fetch(`${base}/vods/test-vod/notice`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const published = JSON.parse(gitFixture(directory, ["--git-dir", origin, "show", "main:vods.json"]));
  assert.ok(published.some((vod) => vod.id === "remote-only"), "admin publication deleted a remote-only VOD");
  assert.ok(published[0].youtube.some((part) => part.id === "remote-part"), "admin publication deleted a remote-only part");
  assert.ok(published[0].vodNotice);
  assert.equal(published.some((vod) => vod.id === "not-yet-published-local"), false, "admin published an unrelated pipeline addition");
  const local = JSON.parse(await fs.readFile(vodsPath, "utf8"));
  assert.ok(local.some((vod) => vod.id === "remote-only"));
  assert.ok(local[0].youtube.some((part) => part.id === "remote-part"));
  assert.ok(local.some((vod) => vod.id === "not-yet-published-local"), "reconciliation deleted a local upload");
  assert.ok(local[0].youtube.some((part) => part.id === "not-yet-published-part"));
});

test("retrying the same admin flag after a failed push retains the original publication delta", async (t) => {
  let origin;
  const { base, headers, directory, vodsPath } = await startFixture(t, {
    autoGitPush: true,
    beforeStart: async ({ directory }) => {
      gitFixture(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      gitFixture(directory, ["add", "vods.json"]);
      gitFixture(directory, ["commit", "--quiet", "-m", "Fixture baseline"]);
      origin = path.join(directory, "origin.git");
      gitFixture(directory, ["init", "--bare", "--quiet", "--initial-branch=main", origin]);
      gitFixture(directory, ["remote", "add", "origin", origin]);
      gitFixture(directory, ["push", "--quiet", "-u", "origin", "main"]);
      gitFixture(directory, ["remote", "set-url", "--push", "origin", path.join(directory, "missing-origin.git")]);
    },
  });
  const change = () => fetch(`${base}/vods/test-vod/notice`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
  const failed = await change();
  assert.equal(failed.status, 500);
  assert.ok(JSON.parse(await fs.readFile(vodsPath, "utf8"))[0].vodNotice);
  assert.equal(JSON.parse(gitFixture(directory, ["--git-dir", origin, "show", "main:vods.json"]))[0].vodNotice, undefined);
  const journal = path.join(directory, "scripts", ".state", "admin-publication.json");
  assert.equal(JSON.parse(await fs.readFile(journal, "utf8")).length, 1);
  gitFixture(directory, ["remote", "set-url", "--push", "origin", origin]);
  const retried = await change();
  assert.equal(retried.status, 200, JSON.stringify(await retried.clone().json()));
  assert.ok(JSON.parse(gitFixture(directory, ["--git-dir", origin, "show", "main:vods.json"]))[0].vodNotice);
  assert.deepEqual(JSON.parse(await fs.readFile(journal, "utf8")), []);
});
