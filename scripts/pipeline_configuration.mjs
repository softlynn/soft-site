const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const validatePipelineState = (state) => {
  if (!isRecord(state)) throw new Error("Archive pipeline state must be a JSON object; refusing to replace recovery history.");
  for (const key of ["processedFiles", "processedVodIds"]) {
    if (!Object.hasOwn(state, key)) state[key] = {};
    if (!isRecord(state[key]) || Object.values(state[key]).some((entry) => !isRecord(entry))) {
      throw new Error(`Archive pipeline state ${key} is invalid; refusing to replace recovery history.`);
    }
  }
  return state;
};

export const validatePipelineConfiguration = (config, { metadataOnly = false } = {}) => {
  if (!["private", "unlisted", "public"].includes(config.youtubePrivacyStatus)) {
    throw new Error("YOUTUBE_PRIVACY_STATUS must be private, unlisted, or public.");
  }
  if (metadataOnly) return;
  const constraints = [
    ["MIN_RECORDING_AGE_MINUTES", config.minRecordingAgeMinutes, 0, false],
    ["MAX_RECORDINGS_PER_RUN", config.maxRecordingsPerRun, 1, true],
    ["MIN_ARCHIVE_VOD_DURATION_SECONDS", config.minArchiveVodDurationSeconds, 1, false],
    ["AUTO_MERGE_VOD_GAP_SECONDS", config.autoMergeVodGapSeconds, 0, false],
    ["YOUTUBE_VISIBILITY_SYNC_INTERVAL_MINUTES", config.youtubeVisibilitySyncIntervalMinutes, 0, false],
  ];
  for (const [name, value, min, integer] of constraints) {
    if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be a finite ${integer ? "integer" : "number"} greater than or equal to ${min}.`);
    }
  }
};
