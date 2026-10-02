import { performance } from "node:perf_hooks";

const stageRank = (state) => ({ preparing: 0, uploading: 1, finalizing: 2, error: 3, paused: 3, skipped: 3, done: 4 })[state] ?? 0;
const terminal = (state) => stageRank(state) >= 3;

// Status is optional telemetry. Keep one request active and only the latest
// pending snapshot for each session. Separate session keys retain terminal
// results when an upload finishes just as another session begins reporting.
export const createStatusPublisher = (send, { timeoutMs = 5000 } = {}) => {
  if (typeof send !== "function") throw new TypeError("Status publisher requires a send callback.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Status timeout must be a finite positive timer duration.");
  }
  const pending = new Map();
  const stages = new Map();
  let draining = false;
  let active = null;

  const deliver = async (key, item) => {
    // A queued terminal report shares the original request budget, rather than
    // adding a second full timeout before the video pipeline can continue.
    const remainingMs = item.deadlineAtMs - performance.now();
    if (remainingMs <= 0) return;
    const controller = new AbortController();
    active = {
      key, snapshot: item.snapshot,
      cancel: () => controller.abort(Object.assign(new Error("A terminal upload status superseded this progress report."), {
        code: "SOFTUCHIVE_STATUS_SUPERSEDED",
      })),
    };
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(Object.assign(new Error("Upload status reporting timed out."), { code: "SOFTUCHIVE_STATUS_TIMEOUT" }));
        resolve();
      }, remainingMs);
    });
    const request = Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return send(item.snapshot, { signal: controller.signal, timeoutMs: remainingMs });
    });
    try {
      await Promise.race([request, expired]);
    } catch {
      // A failed status endpoint must not interrupt or retry the media upload.
    } finally {
      clearTimeout(timer);
      controller.abort();
      active = null;
    }
  };

  const drain = async () => {
    while (pending.size) {
      const [key, item] = pending.entries().next().value;
      pending.delete(key);
      try { await deliver(key, item); }
      finally { item.resolve(); }
    }
    draining = false;
  };

  return (status = {}) => {
    const snapshot = { ...status };
    const key = String(snapshot.sessionId || "");
    const state = String(snapshot.state || "").toLowerCase();
    const rank = stageRank(state);
    // Old metadata refreshes or fire-and-forget progress must never reopen a
    // finalizing/completed session after its terminal report was queued.
    const previous = stages.get(key);
    if (rank < (previous?.rank ?? -1)) return Promise.resolve();
    const createdAtMs = Number.isFinite(Number(snapshot.createdAtMs)) ? Number(snapshot.createdAtMs) : 0;
    snapshot.updatedAtMs = Math.max(Date.now(), createdAtMs, (previous?.updatedAtMs ?? 0) + 1);
    stages.set(key, { rank, updatedAtMs: snapshot.updatedAtMs });
    const deadlineAtMs = performance.now() + timeoutMs;
    let item = pending.get(key);
    if (item) {
      const previousTerminal = terminal(String(item.snapshot.state || "").toLowerCase());
      item.snapshot = snapshot;
      // Replacing progress can refresh its deadline; replacing a terminal
      // snapshot must not prolong an earlier awaited terminal call.
      item.deadlineAtMs = previousTerminal ? Math.min(item.deadlineAtMs, deadlineAtMs) : deadlineAtMs;
    } else {
      item = { snapshot, deadlineAtMs };
      item.done = new Promise((resolve) => { item.resolve = resolve; });
      pending.set(key, item);
    }
    // Final status must have a chance to reach the endpoint within its own
    // budget even when a progress request is stuck. Wait for that request's
    // abort to settle before the drain sends the terminal snapshot.
    if (terminal(state) && active?.key === key && !terminal(String(active.snapshot.state || "").toLowerCase())) {
      active.cancel();
    }
    if (!draining) {
      draining = true;
      void drain();
    }
    return item.done;
  };
};
