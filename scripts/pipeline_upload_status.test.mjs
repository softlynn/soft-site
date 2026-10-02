import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { createStatusPublisher } from "./pipeline_upload_status.mjs";

const fakeTransport = () => {
  const requests = [];
  let active = 0;
  let peak = 0;
  const fetch = async (_url, { body, signal }) => {
    active++;
    peak = Math.max(peak, active);
    let release;
    let onAbort;
    const finished = new Promise((resolve, reject) => {
      release = resolve;
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    requests.push({ status: JSON.parse(body), signal, release });
    try { await finished; return { ok: true }; }
    finally { active--; signal.removeEventListener("abort", onAbort); }
  };
  return {
    send: (status, { signal }) => fetch("https://synthetic.invalid/report", { body: JSON.stringify(status), signal }),
    requests,
    get active() { return active; },
    get peak() { return peak; },
  };
};

test("rapid progress keeps one request active and sends only the latest pending percentage", async () => {
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send);
  const first = publish({ sessionId: "one", state: "uploading", percent: 0 });
  await immediate();
  const pending = Array.from({ length: 100 }, (_, percent) => publish({ sessionId: "one", state: "uploading", percent }));
  assert.equal(new Set(pending).size, 1, "progress callers accumulated separate pending batches");
  assert.equal(transport.requests.length, 1);
  transport.requests[0].release();
  await immediate();
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[1].status.percent, 99);
  transport.requests[1].release();
  await Promise.all([first, ...pending]);
  assert.equal(transport.peak, 1);
  assert.equal(transport.active, 0);
});

test("terminal reports supersede pending progress and cannot be reopened by late metadata or errors", async () => {
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send);
  const first = publish({ sessionId: "one", state: "uploading", percent: 10 });
  await immediate();
  const pending = publish({ sessionId: "one", state: "uploading", percent: 60 });
  let terminalSettled = false;
  const terminal = publish({ sessionId: "one", state: "done", percent: 100 }).then(() => { terminalSettled = true; });
  await publish({ sessionId: "one", state: "uploading", percent: 90 });
  await publish({ sessionId: "one", state: "error", message: "Late optional metadata failure" });
  assert.equal(terminalSettled, false);
  transport.requests[0].release();
  await immediate();
  assert.equal(transport.requests[1].status.state, "done");
  assert.equal(terminalSettled, false, "terminal caller returned before its request finished");
  transport.requests[1].release();
  await Promise.all([first, pending, terminal]);
  await publish({ sessionId: "one", state: "preparing" });
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.peak, 1);
});

test("separate session keys retain their final snapshots without overlapping network requests", async () => {
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send);
  const first = publish({ sessionId: "one", state: "uploading" });
  await immediate();
  const done = publish({ sessionId: "one", state: "done" });
  const second = publish({ sessionId: "two", state: "preparing" });
  transport.requests[0].release();
  await immediate();
  assert.equal(transport.requests[1].status.sessionId, "one");
  assert.equal(transport.requests[1].status.state, "done");
  transport.requests[1].release();
  await immediate();
  assert.equal(transport.requests[2].status.sessionId, "two");
  transport.requests[2].release();
  await Promise.all([first, done, second]);
  assert.equal(transport.peak, 1);
});

test("terminal status interrupts hung progress and is attempted before the progress timeout", async () => {
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send);
  const first = publish({ sessionId: "one", state: "uploading" });
  await immediate();
  const terminal = publish({ sessionId: "one", state: "done" });
  await immediate();
  assert.equal(transport.requests[0].signal.aborted, true);
  assert.equal(transport.requests[0].signal.reason.code, "SOFTUCHIVE_STATUS_SUPERSEDED");
  assert.equal(transport.requests.length, 2, "terminal report waited for the full progress timeout");
  assert.equal(transport.requests[1].status.state, "done");
  assert.equal(transport.peak, 1);
  transport.requests[1].release();
  await Promise.all([first, terminal]);
  assert.equal(transport.active, 0);
});

test("timestamps describe enqueue order and remain monotonic when the wall clock goes backwards", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send);
  const first = publish({ sessionId: "one", createdAtMs: 500, state: "uploading", percent: 1 });
  await immediate();
  now = 1100;
  const second = publish({ sessionId: "one", createdAtMs: 500, state: "uploading", percent: 2 });
  now = 1050;
  const third = publish({ sessionId: "one", createdAtMs: 500, state: "uploading", percent: 3 });
  now = 3000;
  transport.requests[0].release();
  await immediate();
  assert.equal(transport.requests[0].status.updatedAtMs, 1000);
  assert.equal(transport.requests[1].status.updatedAtMs, 1101);
  assert.equal(transport.requests[1].status.createdAtMs, 500);
  transport.requests[1].release();
  await Promise.all([first, second, third]);
});

test("a queued terminal report retains one total timeout budget including the earlier request", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = fakeTransport();
  const publish = createStatusPublisher(transport.send, { timeoutMs: 1000 });
  const first = publish({ sessionId: "one", state: "uploading" });
  await immediate();
  now = 40;
  t.mock.timers.tick(40);
  let terminalSettled = false;
  const terminal = publish({ sessionId: "one", state: "done" }).then(() => { terminalSettled = true; });
  now = 900;
  t.mock.timers.tick(860);
  transport.requests[0].release();
  await immediate();
  assert.equal(transport.requests.length, 2);
  now = 1039;
  t.mock.timers.tick(139);
  await immediate();
  assert.equal(terminalSettled, false);
  now = 1040;
  t.mock.timers.tick(1);
  await Promise.all([first, terminal]);
  assert.equal(transport.requests[1].signal.aborted, true);
  assert.equal(transport.active, 0);
  assert.equal(getEventListeners(transport.requests[1].signal, "abort").length, 0);
});

test("status failures stay optional and completed publishers retain no idle timeout", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set();
  t.mock.method(globalThis, "setTimeout", (...args) => {
    const timer = originalSetTimeout(...args);
    activeTimers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    activeTimers.delete(timer);
    return originalClearTimeout(timer);
  });
  let sends = 0;
  const publish = createStatusPublisher(() => { sends++; throw new Error("Synthetic unavailable endpoint"); });
  await publish({ sessionId: "one", state: "uploading" });
  await publish({ sessionId: "one", state: "done" });
  assert.equal(sends, 2);
  assert.equal(activeTimers.size, 0);
});
