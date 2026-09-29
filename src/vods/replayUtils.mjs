// Chat logs are chronological. Find the first message after the playback clock
// without walking hours of history each time the viewer seeks.
export const findReplayEnd = (comments, time) => {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Number(comments[middle].content_offset_seconds) <= time) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const indexEmotes = (entries) => {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const name of [entry?.name, entry?.code]) {
      if (name && !index.has(name)) index.set(name, entry);
    }
  }
  return index;
};

const nonNegativeNumber = (value) => {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const positiveDuration = (value) => {
  const duration = nonNegativeNumber(value);
  return duration > 0 ? duration : null;
};
const archiveDurationSeconds = (value) => {
  if (typeof value === "number") return nonNegativeNumber(value) || 0;
  const pieces = String(value || "").split(":");
  if (pieces.length > 3 || !pieces.every((piece) => /^\d+$/.test(piece))) return 0;
  return pieces.reduce((total, piece) => total * 60 + Number(piece), 0);
};

// Derive the timeline BEFORE hiding/renumbering parts. Preserve the historical
// prefix convention, but count hidden media too. A missing predecessor cannot
// be treated as zero-length; an explicit origin can resume a known timeline.
export const buildYouTubeTimeline = (entries, archiveDuration = 0) => {
  const ordered = (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const rawOrder = Number(entry?.adminOrder ?? entry?.part);
    const order = Number.isInteger(rawOrder) && rawOrder > 0 ? rawOrder : index + 1;
    return { entry, index, order };
  }).sort((a, b) => a.order - b.order || a.index - b.index);
  const durations = ordered.map(({ entry }) => positiveDuration(entry?.duration));
  const legacyPrefix = durations.every((duration) => duration !== null)
    ? Math.max(0, archiveDurationSeconds(archiveDuration) - durations.reduce((sum, duration) => sum + duration, 0))
    : 0;
  let nextStart = legacyPrefix;
  let expectedOrder = 1;
  return ordered.map(({ entry, order }, index) => {
    if (order !== expectedOrder) nextStart = null;
    const explicitStart = nonNegativeNumber(entry?.timelineStartSeconds);
    const start = explicitStart !== null ? explicitStart
      : entry?.timelineStartSeconds === null ? null : nextStart;
    nextStart = start !== null && durations[index] !== null ? start + durations[index] : null;
    expectedOrder = order + 1;
    return { ...entry, timelineStartSeconds: start };
  });
};

const partStart = (videos, index) => {
  let start = 0;
  for (let i = 0; i <= index; i++) {
    if (Object.hasOwn(videos[i], "timelineStartSeconds")) start = nonNegativeNumber(videos[i].timelineStartSeconds);
    if (i === index) return start;
    const duration = positiveDuration(videos[i].duration);
    start = start !== null && duration !== null ? start + duration : null;
  }
  return null;
};

export const getPlaybackTime = (videos, requestedPart, localTime = 0) => {
  const index = videos.findIndex((video) => Number(video.part) === Number(requestedPart));
  if (index < 0) return null;
  const start = partStart(videos, index);
  const offset = nonNegativeNumber(localTime);
  return start !== null && offset !== null ? start + offset : null;
};

export const resolvePlaybackPosition = (videos, requestedPart, timestamp = 0) => {
  const count = videos.length;
  const parsedPart = Number(requestedPart);
  const index = Number.isInteger(parsedPart) ? Math.min(Math.max(parsedPart, 1), Math.max(count, 1)) - 1 : 0;
  let offset = Number(timestamp);
  offset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  if (offset > 0 && count) {
    let lastKnown = null;
    for (let i = 0; i < count; i++) {
      const start = partStart(videos, i);
      if (start === null) continue;
      const part = videos[i].part || i + 1;
      if (offset < start) return { part, timestamp: 0 };
      const duration = positiveDuration(videos[i].duration);
      if (duration !== null && offset < start + duration) return { part, timestamp: offset - start };
      if (duration === null) {
        const nextKnown = videos.slice(i + 1).map((_, later) => partStart(videos, i + later + 1)).find((value) => value !== null);
        if (nextKnown === undefined || offset < nextKnown) return { part, timestamp: offset - start };
      }
      lastKnown = { part, timestamp: duration === null ? 0 : Math.max(0, duration - 0.1) };
    }
    if (lastKnown) return lastKnown;
  }
  return { part: videos[index]?.part || index + 1, timestamp: 0 };
};
