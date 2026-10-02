import assert from "node:assert/strict";
import test from "node:test";
import { updateRuntimeUploadQueue } from "./pipeline_runtime_queue.mjs";

test("starting and finishing an upload replaces its queued placeholder", () => {
  const queued = [
    { sessionId: "queued-1", state: "queued", recordingPath: "a/same.mkv" },
    { sessionId: "queued-2", state: "queued", recordingPath: "b/same.mkv" },
  ];
  const running = updateRuntimeUploadQueue(queued, { sessionId: "real-1", state: "uploading", recordingPath: "a/same.mkv" });
  assert.equal(running.length, 2);
  assert.equal(running[0].sessionId, "real-1");
  assert.equal(running[1].sessionId, "queued-2");
  const done = updateRuntimeUploadQueue(running, { sessionId: "real-1", state: "done" });
  assert.equal(done.filter((entry) => entry.state === "queued").length, 1);
  assert.equal(queued[0].sessionId, "queued-1", "previous snapshot remains immutable");
});
