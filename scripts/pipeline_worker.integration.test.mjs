import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { readSoftuchiveControl, readSoftuchiveRuntime, readSoftuchiveSettings, writeSoftuchiveControl } from "./softuchive_state.mjs";

const sourceScripts = path.dirname(fileURLToPath(import.meta.url));
const fixtureParent = path.join(sourceScripts, ".tmp");

// Copy the actual worker and its local dependency graph, without .env files,
// credentials, node_modules, live state, or test doubles for pipeline helpers.
const copyWorker = async (fixtureRoot) => {
  const copied = new Set();
  const copy = async (source) => {
    if (copied.has(source)) return;
    const relative = path.relative(sourceScripts, source);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    copied.add(source);
    const contents = await fs.readFile(source, "utf8");
    const destination = path.join(fixtureRoot, "scripts", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    for (const [, specifier] of contents.matchAll(/\b(?:from|import)\s*["'](\.[^"']+)["']/g)) {
      await copy(path.resolve(path.dirname(source), specifier));
    }
  };
  await copy(path.join(sourceScripts, "run_local_archive_pipeline.mjs"));
};

const fixturePreload = String.raw`
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

const audit = { requests: [], blocked: [], unexpected: [] };
process.on('exit', () => fs.writeFileSync(process.env.FIXTURE_AUDIT_PATH, JSON.stringify(audit)));
globalThis.__fixtureBlock = (operation) => {
  audit.blocked.push(operation);
  throw new Error('Integration fixture blocked ' + operation);
};
const deny = (operation) => () => globalThis.__fixtureBlock(operation);
for (const [name, module, methods] of [
  ['http', http, ['request', 'get']], ['https', https, ['request', 'get']],
  ['http2', http2, ['connect']], ['net', net, ['connect', 'createConnection']],
  ['tls', tls, ['connect']], ['dgram', dgram, ['createSocket']],
  ['child_process', childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const method of methods) module[method] = deny(name + '.' + method);
net.Socket.prototype.connect = deny('net.Socket.connect');
syncBuiltinESMExports();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv' || specifier === 'googleapis') return { url: 'fixture:' + specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'fixture:dotenv') return {
      format: 'module', shortCircuit: true,
      source: 'export default { config() { return { parsed: {} }; } };',
    };
    if (url === 'fixture:googleapis') return {
      format: 'module', shortCircuit: true,
      source: "export const google = new Proxy({}, { get() { return globalThis.__fixtureBlock('YouTube/auth'); } });",
    };
    return nextLoad(url, context);
  },
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const route = url.origin + url.pathname;
  audit.requests.push({ route, method: options.method || 'GET' });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (route === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'fixture-token' });
  if (route === 'https://api.twitch.tv/helix/users') return json({ data: [{ id: 'fixture-user', login: 'fixture_channel' }] });
  if (route === 'https://api.twitch.tv/helix/videos') return json({ data: [] });
  if (route === 'https://api.twitch.tv/helix/streams') return json({ data: { invalid: true } });
  if (url.hostname === 'api.twitch.tv' && url.pathname.startsWith('/helix/chat/badges')) return json({ error: 'Fixture optional service unavailable' }, 403);
  if (['api.frankerfacez.com', 'api.betterttv.net', '7tv.io'].includes(url.hostname)) return json({ error: 'Fixture optional service unavailable' }, 403);
  audit.unexpected.push(route);
  throw new Error('Integration fixture received an unexpected request');
};
`;

const withFixture = async (run) => {
  await fs.mkdir(fixtureParent, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(fixtureParent, "worker-integration-"));
  try {
    await copyWorker(fixtureRoot);
    await fs.mkdir(path.join(fixtureRoot, "recordings"));
    await fs.mkdir(path.join(fixtureRoot, "public", "data"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "scripts", ".state"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "public", "data", "vods.json"), "[]\n");
    await fs.writeFile(path.join(fixtureRoot, "scripts", ".state", "pipeline-state.json"), JSON.stringify({ processedFiles: {}, processedVodIds: {} }));
    await fs.writeFile(path.join(fixtureRoot, "fixture-preload.mjs"), fixturePreload);
    await run(fixtureRoot);
  } finally {
    // Only the directory created by this test can be recursively removed.
    assert.equal(path.dirname(fixtureRoot), fixtureParent);
    assert.ok(path.basename(fixtureRoot).startsWith("worker-integration-"));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
};

const runWorker = async (fixtureRoot) => {
  // An allowlist prevents inherited tokens, proxy URLs, NODE_OPTIONS, or user
  // paths from reaching the worker. Every writable configured path is local.
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "SYSTEMDRIVE"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    TEMP: fixtureRoot, TMP: fixtureRoot,
    LOCAL_RECORDINGS_DIR: path.join(fixtureRoot, "recordings"),
    PIPELINE_TMP_DIR: path.join(fixtureRoot, "work-tmp"),
    OBS_VOD_BYPASS_UPLOAD_STATUS_PATH: path.join(fixtureRoot, "obs-status.json"),
    YOUTUBE_CLIENT_SECRET_PATH: path.join(fixtureRoot, "never-used-client.json"),
    YOUTUBE_TOKEN_PATH: path.join(fixtureRoot, "never-used-token.json"),
    TWITCH_CHANNEL_LOGIN: "fixture_channel", TWITCH_CLIENT_ID: "fixture-client", TWITCH_CLIENT_SECRET: "fixture-secret",
    AUTO_GIT_PUSH: "false", LOCAL_PIPELINE_DRY_RUN: "false", YOUTUBE_VISIBILITY_SYNC_ENABLED: "false",
    MIN_RECORDING_AGE_MINUTES: "0", FIXTURE_AUDIT_PATH: path.join(fixtureRoot, "fixture-audit.json"),
  });
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(fixtureRoot, "fixture-preload.mjs")).href,
    path.join(fixtureRoot, "scripts", "run_local_archive_pipeline.mjs"), "--trigger=integration-test",
  ], { cwd: fixtureRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(timedOut, false, `Worker timed out.\n${stdout}\n${stderr}`);
  const auditText = await fs.readFile(env.FIXTURE_AUDIT_PATH, "utf8").catch(() => {
    assert.fail(`Worker did not initialize the isolation preload (exit ${code}).\n${stdout}\n${stderr}`);
  });
  const audit = JSON.parse(auditText);
  assert.deepEqual(audit.blocked, [], "worker attempted a real network, auth, or child-process action");
  assert.deepEqual(audit.unexpected, [], "worker requested an unmocked service");
  await assert.rejects(fs.access(path.join(fixtureRoot, "scripts", ".state", "pipeline-run.lock.json")), { code: "ENOENT" });
  return { code, stdout, stderr, audit };
};

const readPipelineState = async (root) => JSON.parse(await fs.readFile(path.join(root, "scripts", ".state", "pipeline-state.json"), "utf8"));

test("spawned empty poll completes despite optional badge and emote outages", async () => withFixture(async (root) => {
  await writeSoftuchiveControl(root, { uploadThrottleMbps: 4.5, uploadPaused: true });
  const result = await runWorker(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Deferred optional badge refresh/);
  assert.match(result.stdout, /Deferred ffz_emotes refresh/);
  assert.match(result.stdout, /Deferred bttv_emotes refresh/);
  assert.match(result.stdout, /Deferred 7tv_emotes refresh/);
  const runtime = await readSoftuchiveRuntime(root);
  assert.equal(runtime.run.active, false);
  assert.equal(runtime.run.status, "completed");
  assert.equal(runtime.run.lastPollStatus, "completed");
  assert.equal(runtime.run.trigger, "integration-test");
  assert.equal(runtime.run.error, null);
  assert.equal(runtime.run.current, null);
  assert.equal(runtime.run.queue.total, 0);
  assert.equal(runtime.run.queue.remaining, 0);
  assert.deepEqual(runtime.run.uploads, []);
  assert.equal(runtime.run.summary.archivedPartCount, 0);
  assert.ok(runtime.run.completedAt);
  assert.ok(runtime.events.some((event) => event.message.includes("Deferred optional badge refresh")));
  const control = await readSoftuchiveControl(root);
  assert.equal(control.uploadPaused, true);
  assert.equal(control.uploadThrottleMbps, 4.5);
  assert.equal(control.pauseRequested, false);
  assert.equal((await readSoftuchiveSettings(root)).archiveFolder, path.join(root, "recordings"));
  assert.deepEqual(await readPipelineState(root), { processedFiles: {}, processedVodIds: {} });
  assert.equal(result.audit.requests.filter((request) => request.route.endsWith("/oauth2/token")).length, 1);
  assert.ok(result.audit.requests.some((request) => request.route.includes("frankerfacez")));
}));

test("spawned worker refuses a recording when Twitch cannot establish whether streaming finished", async () => withFixture(async (root) => {
  const recording = path.join(root, "recordings", "synthetic-finished.mp4");
  const contents = Buffer.from("fixture media that must never reach ffprobe or upload");
  await fs.writeFile(recording, contents);
  const earlier = new Date(Date.now() - 60_000);
  await fs.utimes(recording, earlier, earlier);
  const result = await runWorker(root);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /Twitch live-stream check returned an invalid response/);
  assert.ok(result.audit.requests.some((request) => request.route.endsWith("/helix/streams")));
  const runtime = await readSoftuchiveRuntime(root);
  assert.equal(runtime.run.active, false);
  assert.equal(runtime.run.status, "error");
  assert.equal(runtime.run.lastPollStatus, "error");
  assert.match(runtime.run.error, /Twitch live-stream check/);
  assert.deepEqual(runtime.run.uploads, []);
  assert.deepEqual(await fs.readFile(recording), contents);
  assert.deepEqual((await readPipelineState(root)).processedFiles, {});
  assert.equal((await readSoftuchiveControl(root)).pauseRequested, false);
}));

test("spawned worker honors a saved pause before any service lookup", async () => withFixture(async (root) => {
  await writeSoftuchiveControl(root, { pauseRequested: true, uploadThrottleMbps: 3 });
  const result = await runWorker(root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.audit.requests, []);
  const runtime = await readSoftuchiveRuntime(root);
  assert.equal(runtime.run.active, false);
  assert.equal(runtime.run.status, "paused");
  assert.equal(runtime.run.lastPollStatus, "paused");
  assert.match(runtime.run.message, /Resume will continue/);
  const control = await readSoftuchiveControl(root);
  assert.equal(control.pauseRequested, true);
  assert.equal(control.uploadThrottleMbps, 3);
  assert.deepEqual((await readPipelineState(root)).processedFiles, {});
}));

test("spawned worker retains orphaned upload evidence when the source recording was replaced", async () => withFixture(async (root) => {
  const recordingPath = path.join(root, "recordings", "replaced.mp4");
  const contents = Buffer.from("replacement recording must not start another upload");
  await fs.writeFile(recordingPath, contents);
  const earlier = new Date(Date.now() - 60_000);
  await fs.utimes(recordingPath, earlier, earlier);
  const oldSource = { size: 100, modifiedAtMs: 1000, changedAtMs: 1000, fileId: "earlier-file", deviceId: "fixture-disk" };
  const preparedPath = path.join(root, "work-tmp", "earlier-track1.mp4");
  const checkpoint = {
    status: "processing", source: oldSource,
    preparedUploadCopy: { path: preparedPath, originalPath: recordingPath, uploadCopyManifestPath: `${preparedPath}.json` },
    uploadSessionId: "orphaned-upload", uploadedBytes: 90, totalBytes: 100, finalAttempted: true,
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await fs.writeFile(path.join(root, "scripts", ".state", "pipeline-state.json"), JSON.stringify({
    processedFiles: { [recordingPath]: checkpoint }, processedVodIds: {},
  }));
  const result = await runWorker(root);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /require recovery before uploading/);
  assert.match(result.stdout, /Retained orphaned upload recovery information/);
  assert.equal(result.audit.requests.some((request) => request.route.endsWith("/helix/streams")), false);
  const saved = (await readPipelineState(root)).processedFiles[recordingPath];
  assert.equal(saved.status, "error");
  assert.match(saved.error, /retained source and prepared upload identity/);
  for (const key of ["source", "preparedUploadCopy", "uploadSessionId", "uploadedBytes", "totalBytes", "finalAttempted", "startedAt"]) {
    assert.deepEqual(saved[key], checkpoint[key], `Worker lost ${key}`);
  }
  assert.deepEqual(await fs.readFile(recordingPath), contents);
  const runtime = await readSoftuchiveRuntime(root);
  assert.equal(runtime.run.active, false);
  assert.equal(runtime.run.status, "error");
  assert.deepEqual(runtime.run.uploads, []);
  assert.match(runtime.run.summary.skippedRecordings[0].reason, /unresolved upload source/);
}));

test("spawned worker refuses malformed recovery state before a service lookup or journal rewrite", async () => withFixture(async (root) => {
  const pipelinePath = path.join(root, "scripts", ".state", "pipeline-state.json");
  await fs.writeFile(pipelinePath, "[]\n");
  const result = await runWorker(root);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /state must be a JSON object/);
  assert.deepEqual(result.audit.requests, []);
  assert.equal(await fs.readFile(pipelinePath, "utf8"), "[]\n");
  const runtime = await readSoftuchiveRuntime(root);
  assert.equal(runtime.run.active, false);
  assert.equal(runtime.run.status, "error");
  assert.match(runtime.run.error, /refusing to replace recovery history/);
}));
