import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

test("real admin login, concurrent flags, and local console stay consistent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "soft-admin-api-"));
  const vodsPath = path.join(directory, "vods.json");
  await fs.mkdir(path.join(directory, "scripts"));
  for (const name of ["run_local_admin_api.mjs", "admin_console.mjs", "pipeline_file_io.mjs"]) {
    await fs.copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(directory, "scripts", name));
  }
  await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true }).status, 0);
  await fs.writeFile(vodsPath, JSON.stringify([{ id: "test-vod", title: "Synthetic fixture", chatReplayAvailable: true }]));
  const child = spawn(process.execPath, [path.join(directory, "scripts", "run_local_admin_api.mjs")], {
    windowsHide: true,
    env: { ...process.env, ADMIN_API_HOST: "127.0.0.1", ADMIN_API_PORT: "0", ADMIN_PANEL_PASSWORD: "fixture-password",
      AUTO_GIT_PUSH: "false", ARCHIVE_VODS_PATH: vodsPath, SITE_DESIGN_PATH: path.join(directory, "design.json"),
      SITE_DESIGN_ASSETS_PATH: path.join(directory, "assets"), ADMIN_API_IDLE_TIMEOUT_MINUTES: "0" },
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
});
