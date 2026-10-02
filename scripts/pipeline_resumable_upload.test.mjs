import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { Gaxios } from "gaxios";

const moduleUrl = new URL("./pipeline_resumable_upload.mjs", import.meta.url);
const loadUploader = async () => {
  const exports = await import(moduleUrl).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  });
  assert.equal(typeof exports.uploadFileResumable, "function", "resumable file uploader is missing");
  return exports.uploadFileResumable;
};

const fixture = async (size = 600_000) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "softuchive-upload-"));
  const filePath = path.join(dir, "recording.mkv");
  const contents = Buffer.alloc(size);
  for (let index = 0; index < size; index++) contents[index] = index % 251;
  await fs.writeFile(filePath, contents);
  let stored = null;
  return { filePath, contents, loadSession: async () => structuredClone(stored),
    saveSession: async (state) => { stored = structuredClone(state); },
    get stored() { return stored; },
    cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); } };
};
const consume = async (body) => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks); };
const response = (status, headers = {}, data = {}) => ({ status, headers, data });
const location = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=offline-test";
const metadata = { snippet: { title: "offline test" }, status: { privacyStatus: "private" } };

test("bounded upload persists session before media, confirms ranges and durably remembers completed video", async () => {
  const upload = await loadUploader();
  const f = await fixture();
  let offset = 0;
  const progress = [];
  const request = async (options) => {
    assert.equal(options.retry, false, "transport must not replay consumed streams");
    if (options.method === "POST") return response(200, { location });
    assert.equal(f.stored.url, location, "media started before session was durable");
    const body = await consume(options.data);
    assert.ok(body.length <= 262_144);
    assert.equal(options.headers["Content-Range"], `bytes ${offset}-${offset + body.length - 1}/${f.contents.length}`);
    assert.deepEqual(body, f.contents.subarray(offset, offset + body.length));
    offset += body.length;
    return offset === f.contents.length ? response(201, {}, { id: "video-1" }) : response(308, { range: `bytes=0-${offset - 1}` });
  };
  try {
    assert.equal(await upload({ ...f, request, metadata, chunkSizeBytes: 262_144, onProgress: (event) => progress.push(event) }), "video-1");
    assert.equal(f.stored.confirmedBytes, f.contents.length);
    assert.equal(f.stored.videoId, "video-1");
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(await upload({ ...f, request: async () => assert.fail("completed session made a network request"), metadata }), "video-1");
  } finally { await f.cleanup(); }
});

test("interrupted chunks query server and resume exactly after confirmed bytes", async () => {
  const upload = await loadUploader();
  const f = await fixture();
  let offset = 0;
  let interrupted = false;
  let probes = 0;
  let starts = 0;
  const request = async (options) => {
    if (options.method === "POST") { starts++; return response(200, { location }); }
    if (options.headers["Content-Length"] === "0") { probes++; return response(308, { range: `bytes=0-${offset - 1}` }); }
    const body = await consume(options.data);
    assert.match(options.headers["Content-Range"], new RegExp(`^bytes ${offset}-`));
    assert.deepEqual(body, f.contents.subarray(offset, offset + body.length));
    if (!interrupted) { interrupted = true; offset = 131_072; throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); }
    offset += body.length;
    return offset === f.contents.length ? response(201, {}, { id: "video-resumed" }) : response(308, { range: `bytes=0-${offset - 1}` });
  };
  try {
    assert.equal(await upload({ ...f, request, metadata, chunkSizeBytes: 262_144, retryBaseDelayMs: 1 }), "video-resumed");
    assert.equal(starts, 1);
    assert.equal(probes, 1);
  } finally { await f.cleanup(); }
});

test("lost final response is recovered by querying the same session without creating duplicate", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let starts = 0;
  let attempts = 0;
  const request = async (options) => {
    if (options.method === "POST") { starts++; return response(200, { location }); }
    if (options.headers["Content-Length"] === "0") return response(201, {}, { id: "already-uploaded" });
    attempts++;
    assert.equal(f.stored.finalAttempted, true, "final attempt was not saved before sending");
    await consume(options.data);
    throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
  };
  try {
    assert.equal(await upload({ ...f, request, metadata, retryBaseDelayMs: 1 }), "already-uploaded");
    assert.equal(starts, 1);
    assert.equal(attempts, 1);
  } finally { await f.cleanup(); }
});

test("speed pause polls at the configured interval instead of busy looping", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let reads = 0;
  let paused = true;
  const release = delay(80).then(() => { paused = false; });
  try {
    await upload({ ...f, metadata, controlPollIntervalMs: 20, readControl: async () => { reads++; return { uploadPaused: paused }; },
      request: async (options) => options.method === "POST" ? response(200, { location }) : (await consume(options.data), response(201, {}, { id: "resumed" })) });
    assert.ok(reads < 20, `paused uploader polled ${reads} times in 80ms`);
  } finally { await release; await f.cleanup(); }
});

test("process restart probes durable session and preserves its original chunk size", async () => {
  const upload = await loadUploader();
  const f = await fixture(800_000);
  let offset = 0;
  let paused = false;
  try {
    await assert.rejects(upload({ ...f, metadata, chunkSizeBytes: 262_144, readControl: async () => ({ pauseRequested: paused }), request: async (options) => {
      if (options.method === "POST") return response(200, { location });
      const body = await consume(options.data); offset += body.length; paused = true;
      return response(308, { range: `bytes=0-${offset - 1}` });
    } }), { code: "SOFTUCHIVE_PAUSED" });
    let probed = false;
    assert.equal(await upload({ ...f, metadata, request: async (options) => {
      assert.notEqual(options.method, "POST");
      if (options.headers["Content-Length"] === "0") { probed = true; return response(308, { range: "bytes=0-262143" }); }
      assert.equal(probed, true);
      const body = await consume(options.data);
      assert.ok(body.length <= 262_144, "restarted upload changed chunk size mid-session");
      assert.deepEqual(body, f.contents.subarray(offset, offset + body.length));
      offset += body.length;
      return offset === f.contents.length ? response(201, {}, { id: "restart-complete" }) : response(308, { range: `bytes=0-${offset - 1}` });
    } }), "restart-complete");
  } finally { await f.cleanup(); }
});

test("repeated session expiry is bounded even when new session creation succeeds", async () => {
  const upload = await loadUploader();
  const f = await fixture();
  let starts = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, maxRetries: 2, chunkSizeBytes: 262_144, request: async (options) => {
      if (options.method === "POST") {
        starts++;
        if (starts > 3) throw new Error("session restart loop was not bounded");
        return response(200, { location });
      }
      return response(404);
    } }), { code: "SOFTUCHIVE_UPLOAD_SESSION_EXPIRED" });
    assert.equal(starts, 3);
  } finally { await f.cleanup(); }
});

test("expired session after an uncertain final request is preserved for verification", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let starts = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, retryBaseDelayMs: 1, request: async (options) => {
      if (options.method === "POST") { starts++; return response(200, { location }); }
      if (options.headers["Content-Length"] === "0") return response(404);
      await consume(options.data);
      throw Object.assign(new Error("final response lost"), { code: "ECONNRESET" });
    } }), { code: "SOFTUCHIVE_UPLOAD_COMPLETION_UNCERTAIN" });
    assert.equal(starts, 1, "uncertain upload created a duplicate session");
    assert.equal(f.stored.url, location);
    assert.equal(f.stored.finalAttempted, true);
  } finally { await f.cleanup(); }
});

test("a changed source cannot reuse a saved session", async () => {
  const upload = await loadUploader();
  const f = await fixture();
  let pause = false;
  try {
    await assert.rejects(upload({ ...f, metadata, readControl: async () => ({ pauseRequested: pause }), request: async () => {
      pause = true; return response(200, { location });
    } }), { code: "SOFTUCHIVE_PAUSED" });
    await fs.appendFile(f.filePath, "changed");
    let requests = 0;
    await assert.rejects(upload({ ...f, metadata, request: async () => { requests++; } }), { code: "SOFTUCHIVE_UPLOAD_SOURCE_CHANGED" });
    assert.equal(requests, 0);
  } finally { await f.cleanup(); }
});

test("skip aborts the HTTP request even after local stream completion and stops monitors", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let skip = false;
  let reads = 0;
  let body;
  let requestSignal;
  const progress = [];
  try {
    await assert.rejects(upload({ ...f, metadata, controlPollIntervalMs: 10,
      readControl: async () => { reads++; return { skipRequested: skip }; },
      onProgress: (event) => progress.push(event), request: async (options) => {
        if (options.method === "POST") return response(200, { location });
        body = options.data;
        requestSignal = options.signal;
        await consume(body);
        skip = true;
        return new Promise(() => {});
      } }), { code: "SOFTUCHIVE_SKIPPED" });
    assert.equal(body.destroyed, true);
    assert.equal(requestSignal.aborted, true);
    assert.ok(progress.every((event) => event.percent < 100), "locally buffered bytes were reported as a completed upload");
    const completedReads = reads;
    await delay(40);
    assert.equal(reads, completedReads, "control monitor survived cancelled upload");
  } finally { await f.cleanup(); }
});

test("stalled final response is aborted and retained when the retry budget is exhausted", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let requestSignal;
  let reads = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, stallTimeoutMs: 25, controlPollIntervalMs: 10, maxRetries: 0,
      readControl: async () => { reads++; return {}; }, request: async (options) => {
        if (options.method === "POST") return response(200, { location });
        await consume(options.data);
        requestSignal = options.signal;
        return new Promise(() => {});
      } }), { code: "SOFTUCHIVE_UPLOAD_RETRY_EXHAUSTED" });
    assert.equal(requestSignal.aborted, true);
    assert.equal(f.stored.finalAttempted, true);
    const completedReads = reads;
    await delay(40);
    assert.equal(reads, completedReads);
  } finally { await f.cleanup(); }
});

test("permanent permission errors are not retried and sensitive transport messages stay private", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let requests = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, request: async (options) => {
      requests++;
      if (options.method === "POST") return response(200, { location });
      throw Object.assign(new Error(`secret token at ${location}`), { response: response(403) });
    } }), (error) => error.code === "SOFTUCHIVE_UPLOAD_HTTP_ERROR" && error.status === 403 && !error.message.includes("secret") && !error.message.includes("upload_id"));
    assert.equal(requests, 2);
    assert.equal(f.stored.url, location);
  } finally { await f.cleanup(); }
});

test("a failed durable session write prevents any media transfer", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let requests = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, saveSession: async () => { throw new Error("disk full"); }, request: async () => {
      requests++;
      return response(200, { location });
    } }), /disk full/);
    assert.equal(requests, 1);
  } finally { await f.cleanup(); }
});

test("malformed acknowledgement cannot skip unconfirmed bytes", async () => {
  const upload = await loadUploader();
  const f = await fixture(600_000);
  try {
    await assert.rejects(upload({ ...f, metadata, request: async (options) => {
      if (options.method === "POST") return response(200, { location });
      await consume(options.data);
      return response(308, { range: "bytes=0-999999999999999" });
    } }), { code: "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR" });
    assert.equal(f.stored.confirmedBytes, 0);
  } finally { await f.cleanup(); }
});

test("temporary server errors query status before resending data", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let calls = 0;
  const methods = [];
  try {
    assert.equal(await upload({ ...f, metadata, retryBaseDelayMs: 1, request: async (options) => {
      methods.push(options.headers["Content-Range"] || "start");
      calls++;
      if (calls === 1) return response(200, { location });
      if (calls === 2) { await consume(options.data); return response(503); }
      if (calls === 3) return response(308);
      await consume(options.data);
      return response(201, {}, { id: "server-recovered" });
    } }), "server-recovered");
    assert.deepEqual(methods, ["start", "bytes 0-99/100", "bytes */100", "bytes 0-99/100"]);
  } finally { await f.cleanup(); }
});

test("real Gaxios transport sends bounded content ranges and accepts 308 without redirecting", async () => {
  const upload = await loadUploader();
  const f = await fixture(300_000);
  let accepted = 0;
  const errors = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await consume(incoming);
      if (incoming.method === "POST") {
        assert.deepEqual(JSON.parse(body), metadata);
        outgoing.writeHead(200, { Location: location }); outgoing.end(); return;
      }
      assert.equal(incoming.headers["content-length"], String(body.length));
      assert.equal(incoming.headers["content-range"], `bytes ${accepted}-${accepted + body.length - 1}/300000`);
      assert.deepEqual(body, f.contents.subarray(accepted, accepted + body.length));
      accepted += body.length;
      if (accepted < 300_000) { outgoing.writeHead(308, { Range: `bytes=0-${accepted - 1}` }); outgoing.end(); }
      else { outgoing.writeHead(201, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ id: "gaxios-video" })); }
    } catch (error) { errors.push(error); outgoing.writeHead(400); outgoing.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Gaxios();
  try {
    const port = server.address().port;
    assert.equal(await upload({ ...f, metadata, chunkSizeBytes: 262_144,
      request: (options) => client.request({ ...options, url: `http://127.0.0.1:${port}/offline` }) }), "gaxios-video");
    assert.deepEqual(errors, []);
    assert.equal(accepted, 300_000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.cleanup();
  }
});

test("invalid retry and timeout configuration cannot create an unbounded uploader", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  try {
    for (const option of [{ maxRetries: NaN }, { stallTimeoutMs: NaN }, { controlPollIntervalMs: 0 }, { retryBaseDelayMs: Infinity }]) {
      await assert.rejects(upload({ ...f, metadata, ...option, request: async () => response(403) }), RangeError);
    }
  } finally { await f.cleanup(); }
});

test("real Gaxios truncated final response probes the existing session instead of uploading twice", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let starts = 0;
  let mediaRequests = 0;
  let probes = 0;
  const server = createServer(async (incoming, outgoing) => {
    await consume(incoming);
    if (incoming.method === "POST") {
      starts++;
      outgoing.writeHead(200, { Location: location }); outgoing.end();
    } else if (incoming.headers["content-range"] === "bytes */100") {
      probes++;
      outgoing.writeHead(201, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ id: "response-recovered" }));
    } else {
      mediaRequests++;
      outgoing.writeHead(201, { "Content-Type": "application/json" });
      outgoing.flushHeaders();
      outgoing.write('{"id":');
      setTimeout(() => outgoing.destroy(), 20);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Gaxios();
  try {
    const port = server.address().port;
    assert.equal(await upload({ ...f, metadata, retryBaseDelayMs: 1,
      request: (options) => client.request({ ...options, url: `http://127.0.0.1:${port}/offline` }) }), "response-recovered");
    assert.equal(starts, 1);
    assert.equal(mediaRequests, 1);
    assert.equal(probes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.cleanup();
  }
});

test("malformed saved checkpoints fail closed before reusing IDs or making requests", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  try {
    await upload({ ...f, metadata, request: async (options) => options.method === "POST" ? response(200, { location }) : (await consume(options.data), response(201, {}, { id: "valid-video-id" })) });
    const complete = f.stored;
    const corruptions = [
      { ...complete, videoId: { corrupted: true } },
      { ...complete, videoId: " " },
      { ...complete, videoId: "<invalid-id>" },
      { ...complete, confirmedBytes: 0 },
      { ...complete, finalAttempted: false },
      { ...complete, chunkSizeBytes: 0 },
      { ...complete, chunkSizeBytes: undefined },
      { ...complete, version: undefined },
      { ...complete, confirmedBytes: NaN },
      { ...complete, url: "https://example.invalid/session" },
      false,
    ];
    let requests = 0;
    for (const checkpoint of corruptions) {
      await assert.rejects(upload({ ...f, metadata, loadSession: async () => checkpoint,
        request: async () => { requests++; return response(403); } }), { code: "SOFTUCHIVE_UPLOAD_SESSION_INVALID" });
    }
    assert.equal(requests, 0);
  } finally { await f.cleanup(); }
});

test("a chunk acknowledgement cannot skip source bytes beyond the request", async () => {
  const upload = await loadUploader();
  const f = await fixture(600_000);
  let mediaRequests = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, chunkSizeBytes: 262_144, request: async (options) => {
      if (options.method === "POST") return response(200, { location });
      mediaRequests++;
      assert.equal((await consume(options.data)).length, 262_144);
      return response(308, { range: "bytes=0-399999" });
    } }), { code: "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR" });
    assert.equal(mediaRequests, 1);
    assert.equal(f.stored.confirmedBytes, 0);
  } finally { await f.cleanup(); }
});

test("live and recovered acknowledgements cannot erase durable server progress", async (t) => {
  const upload = await loadUploader();
  for (const restart of [false, true]) {
    for (const range of [undefined, "bytes=0-131071"]) {
      await t.test(`${restart ? "recovered" : "live"} ${range ?? "missing range"}`, async () => {
        const f = await fixture();
        let mediaRequests = 0;
        let paused = false;
        const options = { ...f, metadata, chunkSizeBytes: 262_144,
          readControl: async () => ({ pauseRequested: paused }), request: async (request) => {
            if (request.method === "POST") return response(200, { location });
            await consume(request.data);
            if (++mediaRequests === 1) {
              paused = restart;
              return response(308, { range: "bytes=0-262143" });
            }
            return response(308, range ? { range } : {});
          } };
        try {
          await assert.rejects(upload(options), { code: restart ? "SOFTUCHIVE_PAUSED" : "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR" });
          if (restart) {
            await assert.rejects(upload({ ...f, metadata, request: async (request) => {
              assert.equal(request.headers["Content-Range"], "bytes */600000");
              return response(308, range ? { range } : {});
            } }), { code: "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR" });
          }
          assert.equal(f.stored.confirmedBytes, 262_144, "contradictory acknowledgement overwrote the checkpoint");
        } finally { await f.cleanup(); }
      });
    }
  }
});

test("complete-byte 308 status responses exhaust the retry budget without resending media", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let probes = 0;
  let mediaRequests = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, retryBaseDelayMs: 0, maxRetries: 2, request: async (options) => {
      if (options.method === "POST") return response(200, { location });
      if (options.headers["Content-Length"] === "0") probes++;
      else { mediaRequests++; await consume(options.data); }
      return response(308, { range: "bytes=0-99" });
    } }), { code: "SOFTUCHIVE_UPLOAD_RETRY_EXHAUSTED" });
    assert.equal(probes, 3);
    assert.equal(mediaRequests, 1);
    assert.equal(f.stored.confirmedBytes, 100);
    assert.equal(f.stored.finalAttempted, true);
    assert.equal(f.stored.videoId, undefined);
  } finally { await f.cleanup(); }
});

test("cancellation interrupts an unresolved control read before HTTP starts", { timeout: 1000 }, async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  const controller = new AbortController();
  const reading = Promise.withResolvers();
  const reason = Object.assign(new Error("cancel while reading control"), { code: "ABORT_ERR" });
  let requests = 0;
  try {
    const uploading = upload({ ...f, metadata, signal: controller.signal, readControl: () => {
      reading.resolve();
      return new Promise(() => {});
    }, request: async () => { requests++; return response(500); } });
    const rejected = assert.rejects(uploading, (error) => error === reason);
    await reading.promise;
    controller.abort(reason);
    await rejected;
    assert.equal(requests, 0);
  } finally { controller.abort(); await f.cleanup(); }
});

test("cancellation delivered during a control read cannot start HTTP afterward", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  const controller = new AbortController();
  let requests = 0;
  try {
    await assert.rejects(upload({ ...f, metadata, signal: controller.signal, readControl: async () => {
      controller.abort(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
      return {};
    }, request: async () => { requests++; return response(403); } }), { code: "ABORT_ERR" });
    assert.equal(requests, 0);
  } finally { await f.cleanup(); }
});

test("an unresolved control read cannot disable the HTTP stall watchdog", { timeout: 1000 }, async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let awaitingResponse = false;
  let pendingReads = 0;
  let requestSignal;
  try {
    await assert.rejects(upload({ ...f, metadata, maxRetries: 0, stallTimeoutMs: 40, controlPollIntervalMs: 10,
      readControl: async () => {
        if (!awaitingResponse) return {};
        pendingReads++;
        return new Promise(() => {});
      }, request: async (options) => {
        if (options.method === "POST") return response(200, { location });
        await consume(options.data);
        requestSignal = options.signal;
        awaitingResponse = true;
        return new Promise(() => {});
      } }), { code: "SOFTUCHIVE_UPLOAD_RETRY_EXHAUSTED" });
    assert.equal(pendingReads, 1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(f.stored.finalAttempted, true);
  } finally { await f.cleanup(); }
});

test("real Gaxios oversized final responses retain the session and recover by status probe", async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  let starts = 0;
  let mediaRequests = 0;
  let probes = 0;
  const server = createServer(async (incoming, outgoing) => {
    await consume(incoming);
    if (incoming.method === "POST") {
      starts++;
      outgoing.writeHead(200, { Location: location }); outgoing.end();
    } else if (incoming.headers["content-range"] === "bytes */100") {
      probes++;
      outgoing.writeHead(201, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ id: "bounded-response-recovered" }));
    } else {
      mediaRequests++;
      outgoing.writeHead(201, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ id: "bounded-response-recovered", excessive: "x".repeat(2 * 1024 * 1024) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Gaxios();
  try {
    const port = server.address().port;
    assert.equal(await upload({ ...f, metadata, retryBaseDelayMs: 0,
      request: (options) => client.request({ ...options, url: `http://127.0.0.1:${port}/offline` }) }), "bounded-response-recovered");
    assert.equal(starts, 1);
    assert.equal(mediaRequests, 1);
    assert.equal(probes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.cleanup();
  }
});

test("overflowing Retry-After headers cannot create an infinite retry deadline", { timeout: 1000 }, async () => {
  const upload = await loadUploader();
  const f = await fixture(100);
  const controller = new AbortController();
  let mediaRequests = 0;
  let probes = 0;
  try {
    assert.equal(await upload({ ...f, metadata, signal: controller.signal, retryBaseDelayMs: 0, request: async (options) => {
      if (options.method === "POST") return response(200, { location });
      if (options.headers["Content-Length"] === "0") { probes++; return response(201, {}, { id: "retry-header-recovered" }); }
      mediaRequests++;
      await consume(options.data);
      return response(503, { "retry-after": "9".repeat(307) });
    } }), "retry-header-recovered");
    assert.equal(mediaRequests, 1);
    assert.equal(probes, 1);
  } finally { controller.abort(); await f.cleanup(); }
});
