import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const SOFTUCHIVE_PAUSE_ERROR_CODE = "SOFTUCHIVE_PAUSED";
const SOFTUCHIVE_SKIP_ERROR_CODE = "SOFTUCHIVE_SKIPPED";
const createPipelineControlError = (message, code) => Object.assign(new Error(message), { code });

const normalizeUploadThrottleMbps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(10000, Math.round(parsed * 100) / 100));
};

export const getUploadHealthState = ({ nowMs, lastByteProgressAtMs, stallTimeoutMs, uploadPaused = false }) => ({
  lastByteProgressAtMs: uploadPaused ? nowMs : lastByteProgressAtMs,
  stalled: !uploadPaused && nowMs - lastByteProgressAtMs >= Math.max(15_000, stallTimeoutMs),
});

export class DynamicUploadThrottleStream extends Transform {
  constructor({ readControl, onChunkSent } = {}) {
    super();
    this.readControl = typeof readControl === "function" ? readControl : async () => ({});
    this.onChunkSent = typeof onChunkSent === "function" ? onChunkSent : null;
    this.activeLimitMbps = null;
    this.limitStartedAtMs = Date.now();
    this.bytesSentUnderLimit = 0;
    this.waitController = new AbortController();
  }

  assertActive() {
    if (this.destroyed) throw createPipelineControlError("Upload stream was closed.", "ERR_STREAM_DESTROYED");
  }

  wait(ms) {
    return delay(ms, undefined, { signal: this.waitController.signal });
  }

  _destroy(error, callback) {
    this.waitController.abort();
    callback(error);
  }

  async waitForControl() {
    while (true) {
      this.assertActive();
      const control = await this.readControl();
      this.assertActive();
      if (control.pauseRequested) {
        throw createPipelineControlError("Pause requested during YouTube upload.", SOFTUCHIVE_PAUSE_ERROR_CODE);
      }
      if (control.skipRequested) {
        throw createPipelineControlError("Skip requested for this VOD.", SOFTUCHIVE_SKIP_ERROR_CODE);
      }
      const uploadThrottleMbps = normalizeUploadThrottleMbps(control.uploadThrottleMbps);
      if (!control.uploadPaused) {
        return {
          uploadPaused: false,
          uploadThrottleMbps,
        };
      }
      if (this.onChunkSent) {
        this.onChunkSent(0, {
          uploadPaused: true,
          uploadThrottleMbps,
          uploadMbps: 0,
        });
      }
      await this.wait(500);
    }
  }

  resetLimitWindow(limitMbps) {
    if (this.activeLimitMbps === limitMbps) return;
    this.activeLimitMbps = limitMbps;
    this.limitStartedAtMs = Date.now();
    this.bytesSentUnderLimit = 0;
  }

  async waitForThrottle(byteLength, limitMbps) {
    if (!Number.isFinite(limitMbps) || limitMbps <= 0) {
      this.resetLimitWindow(null);
      return;
    }

    this.resetLimitWindow(limitMbps);
    const bytesPerSecond = (limitMbps * 1_000_000) / 8;
    this.bytesSentUnderLimit += byteLength;
    const targetElapsedMs = (this.bytesSentUnderLimit / bytesPerSecond) * 1000;
    const elapsedMs = Date.now() - this.limitStartedAtMs;
    const waitForMs = Math.ceil(targetElapsedMs - elapsedMs);
    if (waitForMs > 0) {
      await this.wait(waitForMs);
    }
  }

  async sendChunk(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const control = await this.waitForControl();
      const limitMbps = normalizeUploadThrottleMbps(control.uploadThrottleMbps);
      const bytesPerSecond = limitMbps ? (limitMbps * 1_000_000) / 8 : chunk.length;
      const sliceSize = limitMbps ? Math.max(1024, Math.min(64 * 1024, Math.ceil(bytesPerSecond / 8))) : chunk.length - offset;
      const end = Math.min(chunk.length, offset + sliceSize);
      const slice = chunk.subarray(offset, end);

      await this.waitForThrottle(slice.length, limitMbps);
      this.assertActive();
      this.push(slice);
      if (this.onChunkSent) {
        this.onChunkSent(slice.length, {
          uploadPaused: false,
          uploadThrottleMbps: limitMbps,
        });
      }
      offset = end;
    }
  }

  _transform(chunk, _encoding, callback) {
    this.sendChunk(chunk).then(() => callback(), callback);
  }
}
