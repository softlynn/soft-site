import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { DynamicUploadThrottleStream } from "./pipeline_upload_stream.mjs";

const START_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=true";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "SOFTUCHIVE_UPLOAD_STALLED"]);
const transientTransportError = (error) => {
  // Gaxios/fetch can wrap socket and response-body errors in `cause`.
  // Bound traversal because injected clients may provide cyclic error objects.
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (TRANSIENT_CODES.has(error.code) || error.name === "FetchError" || error.name === "AbortError") return true;
  }
  return false;
};
const failure = (message, code, extras = {}) => Object.assign(new Error(message), { code, ...extras });
const abortReason = (signal) => signal.reason instanceof Error ? signal.reason : failure("Upload cancelled.", "ABORT_ERR");
// Control readers may be waiting on disk I/O. Cancellation must not wait for
// that I/O, and a late result must not restart an already cancelled request.
const readWithAbort = (read, signal) => {
  if (!signal) return read();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(abortReason(signal)); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal);
      return read();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
};
const validVideoId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const header = (headers, name) => typeof headers?.get === "function" ? headers.get(name) : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const fingerprintFile = async (filePath) => {
  const stat = await fs.stat(filePath, { bigint: true });
  if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("Upload source must be a nonempty file.", "SOFTUCHIVE_UPLOAD_SOURCE_INVALID");
  return { path: path.resolve(filePath), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
};
const sameFingerprint = (left, right) => left?.path === right.path && left?.size === right.size && left?.mtimeNs === right.mtimeNs && left?.ctimeNs === right.ctimeNs;
const validateSessionUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && ["www.googleapis.com", "youtube.googleapis.com"].includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port && parsed.pathname === "/upload/youtube/v3/videos") return parsed.href;
  } catch {}
  throw failure("YouTube returned an invalid upload session address.", "SOFTUCHIVE_UPLOAD_SESSION_INVALID");
};
const acknowledgedBytes = (response, totalBytes) => {
  const value = header(response.headers, "range");
  if (!value) return 0;
  const match = /^bytes=0-(\d+)$/i.exec(String(value).trim());
  const bytes = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > totalBytes) throw failure("YouTube returned an invalid confirmed upload range.", "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR");
  return bytes;
};
const retryAfterMs = (response) => {
  const value = header(response?.headers, "retry-after");
  if (!value) return 0;
  const text = String(value).trim();
  const milliseconds = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  // Malformed or overflowing headers must not produce an infinite deadline.
  return Number.isSafeInteger(milliseconds) ? Math.max(0, milliseconds) : 0;
};

// request is an authenticated Gaxios-compatible function. Session snapshots contain
// private upload URLs: persist them locally, never expose them in status or logs.
// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
export const uploadFileResumable = async ({
  filePath, request, metadata, loadSession, saveSession, readControl = async () => ({}), onProgress,
  chunkSizeBytes = 8 * 1024 * 1024, stallTimeoutMs = 120_000, maxRetries = 5,
  retryBaseDelayMs = 1_000, controlPollIntervalMs = 500, signal,
}) => {
  if (typeof request !== "function" || typeof loadSession !== "function" || typeof saveSession !== "function") throw new TypeError("Upload requires request, loadSession and saveSession callbacks.");
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes < 262_144 || chunkSizeBytes % 262_144 !== 0) throw new RangeError("Upload chunks must be a positive multiple of 256 KiB.");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new RangeError("Upload retries must be a nonnegative integer.");
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0 || !Number.isFinite(controlPollIntervalMs) || controlPollIntervalMs <= 0 || !Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) throw new RangeError("Upload timeout and polling settings must be finite positive durations.");
  const fingerprint = await fingerprintFile(filePath);
  const totalBytes = fingerprint.size;
  let session = await loadSession();
  if (session != null) {
    const savedFingerprint = session?.fingerprint;
    if (typeof session !== "object" || Array.isArray(session) || session.version !== 1 ||
      !savedFingerprint || typeof savedFingerprint.path !== "string" || !Number.isSafeInteger(savedFingerprint.size) || savedFingerprint.size <= 0 ||
      typeof savedFingerprint.mtimeNs !== "string" || !/^-?\d+$/.test(savedFingerprint.mtimeNs) || typeof savedFingerprint.ctimeNs !== "string" || !/^-?\d+$/.test(savedFingerprint.ctimeNs) ||
      !Number.isSafeInteger(session.chunkSizeBytes) || session.chunkSizeBytes < 262_144 || session.chunkSizeBytes % 262_144 !== 0 ||
      !Number.isSafeInteger(session.confirmedBytes) || session.confirmedBytes < 0 || session.confirmedBytes > savedFingerprint.size ||
      typeof session.finalAttempted !== "boolean" || (session.confirmedBytes === savedFingerprint.size && !session.finalAttempted) ||
      (session.videoId !== undefined && (!validVideoId(session.videoId) || session.confirmedBytes !== savedFingerprint.size || !session.finalAttempted)) ||
      typeof session.createdAt !== "string" || !Number.isFinite(Date.parse(session.createdAt)) || typeof session.updatedAt !== "string" || !Number.isFinite(Date.parse(session.updatedAt))) {
      throw failure("Saved upload checkpoint is invalid; preserve it for verification before starting another upload.", "SOFTUCHIVE_UPLOAD_SESSION_INVALID");
    }
    session.url = validateSessionUrl(session.url);
    if (!sameFingerprint(savedFingerprint, fingerprint)) throw failure("Upload source changed; keep the previous session separate before starting a new upload.", "SOFTUCHIVE_UPLOAD_SOURCE_CHANGED");
    if (session.videoId) return session.videoId;
  }
  const activeChunkSize = session?.chunkSizeBytes ?? chunkSizeBytes;
  let confirmedBytes = Number(session?.confirmedBytes || 0);
  let failures = 0;
  let expiredSessions = 0;
  let needProbe = Boolean(session);
  let lastReportAt = 0;
  let lastReportedPercent = -1;
  let lastSpeedAt = performance.now();
  let lastSpeedBytes = confirmedBytes;
  let currentMbps = 0;
  let control = {};

  const report = (bytes = confirmedBytes, force = false, complete = false) => {
    if (typeof onProgress !== "function") return;
    const now = performance.now();
    const percent = complete ? 100 : Math.min(99, Math.floor(bytes / totalBytes * 100));
    if (!force && percent === lastReportedPercent && now - lastReportAt < 800) return;
    if (now - lastSpeedAt >= 500) {
      currentMbps = Math.max(0, (bytes - lastSpeedBytes) * 8 / ((now - lastSpeedAt) * 1000));
      lastSpeedAt = now;
      lastSpeedBytes = bytes;
    }
    lastReportAt = now;
    lastReportedPercent = percent;
    onProgress({ uploadedBytes: bytes, confirmedBytes, totalBytes, percent,
      uploadMbps: control.uploadPaused ? 0 : currentMbps, uploadPaused: control.uploadPaused === true,
      uploadThrottleMbps: control.uploadThrottleMbps ?? null });
  };
  const checkControl = async (activeSignal = signal) => {
    const nextControl = await readWithAbort(readControl, activeSignal);
    if (activeSignal?.aborted) throw abortReason(activeSignal);
    control = nextControl;
    if (control.skipRequested) throw failure("Skip requested for this VOD.", "SOFTUCHIVE_SKIPPED");
    if (control.pauseRequested) throw failure("Archive paused; this upload can resume from YouTube's confirmed position.", "SOFTUCHIVE_PAUSED");
    return control;
  };
  const waitControlled = async (milliseconds = 0) => {
    const deadline = performance.now() + milliseconds;
    do {
      await checkControl();
      if (control.uploadPaused) report(confirmedBytes);
      if (!control.uploadPaused && performance.now() >= deadline) return;
      await delay(control.uploadPaused ? controlPollIntervalMs : Math.min(controlPollIntervalMs, Math.max(1, deadline - performance.now())), undefined, { signal });
    } while (true);
  };
  const persist = async (patch) => {
    session = { ...session, ...patch, updatedAt: new Date().toISOString() };
    await saveSession(structuredClone(session));
  };

  const performRequest = async (options, range = null) => {
    await waitControlled();
    const controller = new AbortController();
    let source;
    let body;
    let sent = 0;
    let lastProgressAt = performance.now();
    let checking = false;
    let settled = false;
    let abortReject;
    const aborted = new Promise((_resolve, reject) => { abortReject = reject; });
    const abort = (error) => {
      if (settled || controller.signal.aborted) return;
      controller.abort(error);
      abortReject(error);
    };
    const externalAbort = () => abort(abortReason(signal));
    signal?.addEventListener("abort", externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    const timer = setInterval(() => {
      if (settled || controller.signal.aborted) return;
      // The watchdog cannot sit behind an asynchronous control read: a stuck
      // reader would otherwise disable both request and response timeouts.
      if (control.uploadPaused) lastProgressAt = performance.now();
      else if (performance.now() - lastProgressAt >= stallTimeoutMs) {
        abort(failure("YouTube upload stopped responding; its saved session can be resumed.", "SOFTUCHIVE_UPLOAD_STALLED"));
        return;
      }
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          await checkControl(controller.signal);
          if (settled) return;
          if (control.uploadPaused) { lastProgressAt = performance.now(); report(range ? range.start + sent : confirmedBytes); }
        } catch (error) { abort(error); }
        finally { checking = false; }
      })();
    }, Math.min(controlPollIntervalMs, Math.max(10, stallTimeoutMs / 2)));
    try {
      if (range) {
        source = createReadStream(filePath, { start: range.start, end: range.end, highWaterMark: 64 * 1024 });
        body = new DynamicUploadThrottleStream({ readControl: () => checkControl(controller.signal), onChunkSent: (bytes, patch) => {
          control = { ...control, ...patch };
          sent += bytes;
          if (bytes > 0 || patch.uploadPaused) lastProgressAt = performance.now();
          report(range.start + sent);
        } });
        source.on("error", abort);
        body.on("error", abort);
        source.pipe(body);
      }
      const response = await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return request({ ...options, ...(body ? { data: body } : {}),
          signal: controller.signal, retry: false, maxRedirects: 0, timeout: 0,
          maxContentLength: MAX_RESPONSE_BYTES, validateStatus: () => true });
      }), aborted]);
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error?.response) return error.response;
      if (transientTransportError(error)) throw failure("YouTube connection was interrupted; the saved upload will be resumed.", "SOFTUCHIVE_UPLOAD_NETWORK_ERROR", { transient: true });
      // Gaxios errors can embed authenticated URLs. Never propagate their message.
      throw failure("YouTube upload request failed. The saved session is retained.", "SOFTUCHIVE_UPLOAD_REQUEST_FAILED");
    } finally {
      settled = true;
      clearInterval(timer);
      signal?.removeEventListener("abort", externalAbort);
      source?.unpipe(body);
      source?.destroy();
      body?.destroy();
      if (!controller.signal.aborted) controller.abort();
    }
  };
  const complete = async (response) => {
    const id = response?.data?.id;
    if (!validVideoId(id)) throw failure("YouTube accepted the upload without a valid video ID; the saved session needs verification.", "SOFTUCHIVE_UPLOAD_COMPLETION_UNCERTAIN");
    confirmedBytes = totalBytes;
    await persist({ confirmedBytes, videoId: id, finalAttempted: true });
    report(totalBytes, true, true);
    return id;
  };
  const retry = async (response) => {
    failures++;
    if (failures > maxRetries) throw failure("YouTube upload retries exhausted; the saved session will resume on the next run.", "SOFTUCHIVE_UPLOAD_RETRY_EXHAUSTED");
    needProbe = Boolean(session);
    const backoffMs = retryBaseDelayMs === 0 ? 0 : Math.min(60_000, retryBaseDelayMs * 2 ** (failures - 1));
    await waitControlled(Math.max(retryAfterMs(response), backoffMs));
  };

  while (true) {
    await waitControlled();
    if (!sameFingerprint(await fingerprintFile(filePath), fingerprint)) throw failure("Upload source changed while uploading. The saved session has been retained.", "SOFTUCHIVE_UPLOAD_SOURCE_CHANGED");
    let response;
    let requestRange = null;
    let probing = false;
    try {
      if (!session) {
        response = await performRequest({ method: "POST", url: START_URL, headers: {
          "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/x-matroska", "X-Upload-Content-Length": String(totalBytes),
        }, data: metadata });
        if (response.status >= 200 && response.status < 300) {
          await persist({ version: 1, url: validateSessionUrl(header(response.headers, "location")), fingerprint, chunkSizeBytes: activeChunkSize,
            confirmedBytes: 0, finalAttempted: false, createdAt: new Date().toISOString() });
          confirmedBytes = 0;
          needProbe = false;
          failures = 0;
          continue;
        }
      } else if (needProbe || confirmedBytes >= totalBytes) {
        probing = true;
        response = await performRequest({ method: "PUT", url: session.url,
          headers: { "Content-Length": "0", "Content-Range": `bytes */${totalBytes}` }, data: "" });
      } else {
        const end = Math.min(totalBytes - 1, confirmedBytes + activeChunkSize - 1);
        requestRange = { start: confirmedBytes, end };
        if (end === totalBytes - 1) await persist({ finalAttempted: true });
        response = await performRequest({ method: "PUT", url: session.url, headers: {
          "Content-Type": "video/x-matroska", "Content-Length": String(end - confirmedBytes + 1),
          "Content-Range": `bytes ${confirmedBytes}-${end}/${totalBytes}`,
        } }, requestRange);
      }
    } catch (error) {
      if (error?.transient || error?.code === "SOFTUCHIVE_UPLOAD_STALLED") { await retry(); continue; }
      throw error;
    }
    if (session && response.status >= 200 && response.status < 300) return complete(response);
    if (session && response.status === 308) {
      const previousBytes = confirmedBytes;
      const nextBytes = acknowledgedBytes(response, requestRange ? requestRange.end + 1 : totalBytes);
      if (nextBytes < previousBytes) throw failure("YouTube's confirmed upload range moved backwards; the saved checkpoint needs verification.", "SOFTUCHIVE_UPLOAD_PROTOCOL_ERROR");
      confirmedBytes = nextBytes;
      await persist({ confirmedBytes, finalAttempted: confirmedBytes >= totalBytes });
      report(confirmedBytes, true);
      if (confirmedBytes === previousBytes && (!probing || confirmedBytes === totalBytes)) { await retry(response); continue; }
      if (confirmedBytes > previousBytes) failures = 0;
      needProbe = false;
      if (retryAfterMs(response)) await waitControlled(retryAfterMs(response));
      continue;
    }
    if (session && [404, 410].includes(response.status)) {
      if (session.finalAttempted) throw failure("The upload session expired after its final bytes may have been accepted. Verify the existing YouTube upload before creating another.", "SOFTUCHIVE_UPLOAD_COMPLETION_UNCERTAIN");
      if (++expiredSessions > maxRetries) throw failure("YouTube repeatedly rejected the upload session.", "SOFTUCHIVE_UPLOAD_SESSION_EXPIRED");
      session = null;
      await saveSession(null);
      confirmedBytes = 0;
      needProbe = false;
      continue;
    }
    if (TRANSIENT_STATUS.has(response.status)) { await retry(response); continue; }
    throw failure(`YouTube upload was rejected (HTTP ${Number(response.status) || "unknown"}); the saved session is retained.`, "SOFTUCHIVE_UPLOAD_HTTP_ERROR", { status: response.status });
  }
};
