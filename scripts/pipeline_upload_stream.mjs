import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

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
    this.nextSendAtMs = performance.now();
    this.timerRoundingCreditMs = 0;
    this.resumeReadable = null;
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
    this.resumeReadable?.();
    this.resumeReadable = null;
    callback(error);
  }

  _read(size) {
    const resume = this.resumeReadable;
    this.resumeReadable = null;
    resume?.();
    super._read(size);
  }

  async waitForReadableDemand() {
    this.assertActive();
    if (this.readableLength < this.readableHighWaterMark) return;
    const blockedAtMs = performance.now();
    await new Promise((resolve) => { this.resumeReadable = resolve; });
    this.assertActive();
    // Preserve rounding compensation for an immediately draining consumer;
    // actual destination delays must not earn credit toward a later burst.
    const nowMs = performance.now();
    if (nowMs - blockedAtMs > this.timerRoundingCreditMs) {
      this.nextSendAtMs = nowMs;
      this.timerRoundingCreditMs = 0;
    }
  }

  async readActiveControl() {
    this.assertActive();
    const { signal } = this.waitController;
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => reject(createPipelineControlError("Upload stream was closed.", "ERR_STREAM_DESTROYED"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([this.readControl(), cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async waitForControl() {
    while (true) {
      this.assertActive();
      const control = await this.readActiveControl();
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
      this.nextSendAtMs = performance.now();
      this.timerRoundingCreditMs = 0;
      await this.wait(500);
    }
  }

  resetLimitWindow(limitMbps) {
    if (this.activeLimitMbps === limitMbps) return;
    this.activeLimitMbps = limitMbps;
    this.nextSendAtMs = performance.now();
    this.timerRoundingCreditMs = 0;
  }

  async waitForThrottle(byteLength, limitMbps) {
    if (!Number.isFinite(limitMbps) || limitMbps <= 0) {
      this.resetLimitWindow(null);
      return;
    }

    this.resetLimitWindow(limitMbps);
    const bytesPerSecond = (limitMbps * 1_000_000) / 8;
    const nowMs = performance.now();
    // Preserve at most the previous timer's rounding error. Without it, rounding
    // every sub-millisecond slice up to 1 ms caps even a 10 Gbps limit near
    // 524 Mbps. Idle time still cannot accumulate unbounded bandwidth credit.
    this.nextSendAtMs = Math.max(nowMs - this.timerRoundingCreditMs, this.nextSendAtMs) + byteLength / bytesPerSecond * 1000;
    const waitForMs = Math.ceil(this.nextSendAtMs - nowMs);
    if (waitForMs > 0) {
      await this.wait(waitForMs);
    }
    this.timerRoundingCreditMs = Math.min(1, Math.max(0, performance.now() - this.nextSendAtMs));
  }

  async sendChunk(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const control = await this.waitForControl();
      const limitMbps = normalizeUploadThrottleMbps(control.uploadThrottleMbps);
      const bytesPerSecond = limitMbps ? (limitMbps * 1_000_000) / 8 : chunk.length;
      // Keep control checks within roughly 125 ms even at the lowest limit and
      // bound buffering when an upstream writer supplies a very large chunk.
      const sliceSize = limitMbps ? Math.max(1, Math.min(64 * 1024, Math.floor(bytesPerSecond / 8))) : 64 * 1024;
      const end = Math.min(chunk.length, offset + sliceSize);
      const slice = chunk.subarray(offset, end);

      await this.waitForThrottle(slice.length, limitMbps);
      this.assertActive();
      const hasCapacity = this.push(slice);
      if (this.onChunkSent) {
        this.onChunkSent(slice.length, {
          uploadPaused: false,
          uploadThrottleMbps: limitMbps,
        });
      }
      offset = end;
      if (!hasCapacity) await this.waitForReadableDemand();
    }
  }

  _transform(chunk, _encoding, callback) {
    this.sendChunk(chunk).then(() => callback(), callback);
  }
}
