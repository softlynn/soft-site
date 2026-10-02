import assert from "node:assert/strict";
import test from "node:test";
import { fetchPipelineJson, retryDelayMs } from "./pipeline_network.mjs";

test("Twitch rate reset and Retry-After are respected before retrying", async () => {
  let calls = 0;
  const waits = [];
  const value = await fetchPipelineJson("https://example.invalid", {}, {
    now: () => 1000, sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => ++calls === 1
      ? new Response("slow down", { status: 429, headers: { "ratelimit-reset": "3" } })
      : Response.json({ data: [] }),
  });
  assert.deepEqual(value, { data: [] });
  assert.equal(calls, 2);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 2000);
  assert.equal(retryDelayMs(new Headers({ "retry-after": "5", "ratelimit-reset": "3" }), 1, 1000), 5000);
});

test("long server backoff fails safely instead of retrying before reset", async () => {
  let calls = 0;
  await assert.rejects(fetchPipelineJson("https://example.invalid", {}, {
    maxRetryDelayMs: 1000, fetchImpl: async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "60" } }); },
  }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("network failures retry but authorization and malformed successful responses do not", async () => {
  let calls = 0;
  await fetchPipelineJson("https://example.invalid", {}, {
    sleep: async () => {}, fetchImpl: async () => { if (++calls < 3) throw new TypeError("network"); return Response.json({}); },
  });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(fetchPipelineJson("https://example.invalid", {}, {
    fetchImpl: async () => { calls++; return new Response("", { status: 401 }); },
  }), /HTTP 401/);
  assert.equal(calls, 1);
  await assert.rejects(fetchPipelineJson("https://example.invalid", {}, { fetchImpl: async () => new Response("bad-json") }), /invalid JSON/);
});

test("deadline also bounds a response body that never finishes", async () => {
  let requestSignal;
  await assert.rejects(fetchPipelineJson("https://example.invalid/secret", {}, {
    timeoutMs: 10, attempts: 1, label: "Twitch check",
    fetchImpl: async (_url, { signal }) => { requestSignal = signal; return { ok: true, json: () => new Promise(() => {}) }; },
  }), /Twitch check timed out/);
  assert.equal(requestSignal.aborted, true);
});

test("pause during rate-limit backoff is propagated without another request", async () => {
  let paused = false;
  let calls = 0;
  const pause = Object.assign(new Error("paused"), { code: "SOFTUCHIVE_PAUSED" });
  await assert.rejects(fetchPipelineJson("https://example.invalid", {}, {
    beforeRequest: async () => { if (paused) throw pause; },
    sleep: async () => { paused = true; },
    fetchImpl: async () => { calls++; return new Response("", { status: 503 }); },
  }), (error) => error === pause);
  assert.equal(calls, 1);
});

test("non-idempotent requests require an explicit retry policy", async () => {
  let calls = 0;
  await assert.rejects(fetchPipelineJson("https://example.invalid", { method: "POST" }, {
    fetchImpl: async () => { calls++; return new Response("", { status: 503 }); },
  }), /HTTP 503/);
  assert.equal(calls, 1);
});

test("external abort ends a stalled body even when the fetch adapter ignores its signal", async () => {
  const controller = new AbortController();
  const operation = fetchPipelineJson("https://example.invalid", { signal: controller.signal }, {
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  setTimeout(() => controller.abort(new Error("cancelled")), 5);
  await assert.rejects(operation, /cancelled/);
});

test("JSON responses are bounded even without Content-Length", async () => {
  for (const headers of [{}, { "content-length": "100" }]) {
    await assert.rejects(fetchPipelineJson("https://example.invalid", {}, {
      maxResponseBytes: 8, fetchImpl: async () => new Response('{"data":[1,2,3]}', { headers }),
    }), { code: "PIPELINE_RESPONSE_TOO_LARGE" });
  }
});
