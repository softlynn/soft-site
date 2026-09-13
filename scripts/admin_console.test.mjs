import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAdminConsole, isAllowedAdminOrigin } from "./admin_console.mjs";

test("local console serves the built admin, current data, assets, and refresh routes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "soft-admin-console-"));
  const buildRoot = path.join(root, "build"), publicRoot = path.join(root, "public");
  await fs.mkdir(path.join(buildRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(publicRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(publicRoot, "media"), { recursive: true });
  await fs.writeFile(path.join(buildRoot, "index.html"), '<html><head></head><body><script src="./assets/main.js"></script></body></html>');
  await fs.writeFile(path.join(buildRoot, "assets", "main.js"), "/* public app */");
  await fs.writeFile(path.join(publicRoot, "data", "vods.json"), '[{"id":"123"}]');
  await fs.writeFile(path.join(publicRoot, "media", "logo.webm"), "fixture");
  const serve = createAdminConsole({ buildRoot, publicRoot });
  const server = http.createServer(async (req, res) => {
    if (!await serve(req, res, new URL(req.url, "http://local").pathname)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/console/admin/design`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<base href="\/console\/">/);
  assert.equal((await fetch(`${base}/console/assets/main.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  const data = await fetch(`${base}/data/vods.json`);
  assert.deepEqual(await data.json(), [{ id: "123" }]);
  assert.equal((await fetch(`${base}/data/vods.json`, { headers: { "If-None-Match": data.headers.get("etag") } })).status, 304);
  assert.equal((await fetch(`${base}/media/logo.webm`)).headers.get("content-type"), "video/webm");
  assert.equal((await fetch(`${base}/console/.env.local`)).status, 404);
  assert.equal((await fetch(`${base}/console/%2e%2e%5csecret.json`)).status, 404);
  assert.equal((await fetch(`${base}/secrets/youtube_token.json`)).status, 404);
  assert.equal((await fetch(`${base}/console/assets/missing.js`)).status, 404);
});

test("admin origins are exact configured sites or loopback browser origins", () => {
  const allowed = new Set(["https://softu.one"]);
  assert.equal(isAllowedAdminOrigin("https://softu.one", allowed), true);
  assert.equal(isAllowedAdminOrigin("http://127.0.0.1:49731", allowed), true);
  assert.equal(isAllowedAdminOrigin("http://localhost:5173", allowed), true);
  assert.equal(isAllowedAdminOrigin("https://unrelated.example", allowed), false);
  assert.equal(isAllowedAdminOrigin("http://localhost.example", allowed), false);
  assert.equal(isAllowedAdminOrigin("null", allowed), false);
});
