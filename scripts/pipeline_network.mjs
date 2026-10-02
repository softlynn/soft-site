import { setTimeout as delay } from "node:timers/promises";

const retryableStatus = (status) => [408, 425, 429, 500, 502, 503, 504].includes(status);

const readBoundedJson = async (response, maxBytes, label) => {
  const tooLarge = () => Object.assign(new Error(`${label} response exceeds the supported size.`), { code: "PIPELINE_RESPONSE_TOO_LARGE" });
  if (Number(response.headers?.get?.("content-length")) > maxBytes) {
    await response.body?.cancel?.();
    throw tooLarge();
  }
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
};

export const retryDelayMs = (headers, attempt, now = Date.now()) => {
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter != null && String(retryAfter).trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  }
  const reset = Number(headers?.get?.("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return Math.min(8000, 1000 * 2 ** (attempt - 1));
};

// Apply deadlines to headers and body reads. Never expose request URLs or credentials.
export const fetchPipelineJson = async (url, options = {}, {
  label = "Archive API", fetchImpl = fetch,
  attempts = ["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase()) ? 3 : 1,
  timeoutMs = 30_000,
  maxResponseBytes = 16 * 1024 * 1024,
  maxRetryDelayMs = 60_000, allowNotFound = false, beforeRequest = async () => {},
  sleep = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now,
} = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await beforeRequest();
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timer;
    let onAbort;
    let response;
    let retry = false;
    try {
      return await Promise.race([
        (async () => {
          response = await fetchImpl(url, { ...options, signal });
          if (allowNotFound && response.status === 404) {
            await response.body?.cancel?.();
            return null;
          }
          if (!response.ok) {
            retry = retryableStatus(response.status);
            await response.body?.cancel?.();
            throw new Error(`${label} failed (HTTP ${response.status}).`);
          }
          return await readBoundedJson(response, maxResponseBytes, label);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            retry = true;
            const error = Object.assign(new Error(`${label} timed out.`), { code: "ETIMEDOUT" });
            reject(error);
            controller.abort(error);
          }, timeoutMs);
        }),
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason || new Error(`${label} aborted.`));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof TypeError && !response) retry = true;
      const waitMs = retryDelayMs(response?.headers, attempt, now());
      if (!retry || attempt >= attempts || waitMs > maxRetryDelayMs) {
        if (error instanceof SyntaxError) throw new Error(`${label} returned invalid JSON.`);
        if (error instanceof TypeError || (!response && error.code !== "ETIMEDOUT")) throw new Error(`${label} network request failed.`);
        throw error;
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Poll controls while rate limited so a pause does not wait out the retry delay.
      for (let remaining = waitMs; remaining > 0; remaining -= 500) {
        await beforeRequest();
        await sleep(Math.min(500, remaining), options.signal);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`${label} has no request attempts configured.`);
};
