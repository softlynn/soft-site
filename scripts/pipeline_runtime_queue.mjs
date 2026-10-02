export const updateRuntimeUploadQueue = (uploads, patch, now = Date.now()) => {
  const queue = Array.isArray(uploads) ? [...uploads] : [];
  const sessionId = String(patch?.sessionId || "").trim();
  if (!sessionId) return queue;
  let index = queue.findIndex((entry) => String(entry?.sessionId || "") === sessionId);
  if (index < 0 && patch.recordingPath) {
    index = queue.findIndex((entry) => entry.state === "queued" && entry.recordingPath === patch.recordingPath);
  }
  const next = { ...(index >= 0 ? queue[index] : {}), ...patch, updatedAtMs: now };
  if (index >= 0) queue[index] = next;
  else queue.push(next);
  return queue;
};
