// Softuchive control vocabulary shared by the state file, the upload stream,
// and the archive pipeline: the signals that stop a run and the upload speed
// limit read from the control file.
export const SOFTUCHIVE_PAUSE_ERROR_CODE = "SOFTUCHIVE_PAUSED";
export const SOFTUCHIVE_SKIP_ERROR_CODE = "SOFTUCHIVE_SKIPPED";

export const createPipelineControlError = (message, code) => Object.assign(new Error(message), { code });

// Only a finite positive number or numeric string is a limit. Anything else,
// including booleans and objects that Number() would coerce, means "no limit".
export const normalizeUploadThrottleMbps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(10000, Math.round(parsed * 100) / 100));
};
