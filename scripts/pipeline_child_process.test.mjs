import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { runPipelineChild } from "./pipeline_child_process.mjs";

test("pause stops the child but retains ownership until close", async () => {
  const child = new EventEmitter();
  const stops = [];
  let finished = false;
  const operation = runPipelineChild("chat", [], {
    spawnImpl: () => child, shouldPause: async () => true, pollIntervalMs: 1,
    stopChild: (_child, force) => stops.push(force), killGraceMs: 10,
  }).catch((error) => { finished = true; return error; });
  await delay(30);
  assert.equal(finished, false);
  assert.deepEqual(stops, [false, true]);
  child.emit("close", null, "SIGKILL");
  assert.equal((await operation).code, "SOFTUCHIVE_PAUSED");
});

test("timeout terminates and waits for a child before reporting failure", async () => {
  const child = new EventEmitter();
  const operation = runPipelineChild("chat", [], {
    spawnImpl: () => child, timeoutMs: 5,
    stopChild: () => queueMicrotask(() => child.emit("close", 1)),
  });
  await assert.rejects(operation, { code: "ETIMEDOUT" });
});

test("success clears timers and a missing executable rejects", async () => {
  const child = new EventEmitter();
  const operation = runPipelineChild("chat", [], { spawnImpl: () => child });
  child.emit("close", 0);
  await operation;
  const missing = new EventEmitter();
  const failed = runPipelineChild("missing", [], { spawnImpl: () => missing });
  missing.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" }));
  await assert.rejects(failed, { code: "ENOENT" });
});

test("an aborted signal never launches a child", async () => {
  const controller = new AbortController();
  const error = new Error("stop");
  controller.abort(error);
  await assert.rejects(runPipelineChild("chat", [], { signal: controller.signal, spawnImpl: () => assert.fail("spawn") }), error);
});

test("failed graceful termination still escalates and retains ownership", async () => {
  const child = new EventEmitter();
  const stops = [];
  const operation = runPipelineChild("chat", [], {
    spawnImpl: () => child, timeoutMs: 1, killGraceMs: 5,
    stopChild: (_child, force) => { stops.push(force); if (!force) throw new Error("kill failed"); child.emit("close", 1); },
  });
  await assert.rejects(operation, { code: "ETIMEDOUT" });
  assert.deepEqual(stops, [false, true]);
});

test("captured probe output is bounded and the original process is stopped on overflow", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const operation = runPipelineChild("probe", [], {
    spawnImpl: () => child, captureOutput: true, maxOutputBytes: 4,
    stopChild: () => queueMicrotask(() => child.emit("close", 1)),
  });
  child.stdout.emit("data", Buffer.from("12345"));
  await assert.rejects(operation, /too much output/);
});
