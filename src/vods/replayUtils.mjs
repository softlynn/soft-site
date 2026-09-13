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

export const resolvePlaybackPosition = (videos, requestedPart, timestamp = 0) => {
  const count = videos.length;
  const parsedPart = Number(requestedPart);
  let index = Number.isInteger(parsedPart) ? Math.min(Math.max(parsedPart, 1), Math.max(count, 1)) - 1 : 0;
  let offset = Number(timestamp);
  offset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  if (offset > 0 && count) {
    index = 0;
    while (index < count - 1) {
      const duration = Number(videos[index].duration);
      if (!Number.isFinite(duration) || duration <= 0 || offset < duration) break;
      offset -= duration;
      index += 1;
    }
    const duration = Number(videos[index].duration);
    if (duration > 0) offset = Math.min(offset, Math.max(0, duration - 0.1));
  }
  return { part: videos[index]?.part || index + 1, timestamp: offset };
};
