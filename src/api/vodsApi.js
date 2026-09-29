import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";
import { buildYouTubeTimeline } from "../vods/replayUtils.mjs";

const STATIC_DATA_PATH = `${process.env.PUBLIC_URL || ""}/data/vods.json`;
const STATIC_COMMENTS_BASE = `${process.env.PUBLIC_URL || ""}/data/comments`;
const STATIC_EMOTES_BASE = `${process.env.PUBLIC_URL || ""}/data/emotes`;
const STATIC_BADGES_PATH = `${process.env.PUBLIC_URL || ""}/data/badges.json`;
const LOCAL_VOD_OVERRIDES_KEY = "softu-vod-overrides";
const LOCAL_VOD_OVERRIDE_TTL_MS = 30 * 60 * 1000;
const SPOTIFY_NOTICE_OLD = "Spotify audio is muted on this VOD.";
const SPOTIFY_NOTICE_NEW = "Spotify audio may be muted on this VOD.";

let staticVodsCache = null;
let staticVodsRequest = null;
let staticVodsLoadedAt = 0;
const STATIC_VODS_CACHE_MS = 15000;
const staticCommentsCache = new Map();
const staticCommentsRequests = new Map();
const staticEmotesCache = new Map();
const staticEmotesRequests = new Map();
let staticBadgesCache = null;
let staticBadgesRequest = null;
let localVodOverridesCache = null;

const DEFAULT_EMOTES = {
  ffz_emotes: [],
  bttv_emotes: [],
  "7tv_emotes": [],
  embedded_emotes: [],
};
const DEFAULT_BADGES = {
  channel: [],
  global: [],
};

const isEmptyObject = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

const toComparableDate = (value) => new Date(value || 0).getTime();

const textMatches = (text, search) => {
  if (!search) return true;
  return String(text || "").toLowerCase().includes(String(search).toLowerCase());
};

const chapterMatches = (chapters, game) => {
  if (!game) return true;
  if (!Array.isArray(chapters)) return false;
  return chapters.some((chapter) => textMatches(chapter.name, game));
};

const readLocalVodOverrides = () => {
  try {
    if (!localVodOverridesCache) {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(LOCAL_VOD_OVERRIDES_KEY) : null;
      localVodOverridesCache = raw ? JSON.parse(raw) || {} : {};
    }
    const now = Date.now();
    let changed = false;
    const next = {};
    for (const [vodId, override] of Object.entries(localVodOverridesCache)) {
      if (!override || typeof override !== "object") {
        changed = true;
        continue;
      }
      const savedAt = Number(override.savedAt);
      if (!Number.isFinite(savedAt) || now - savedAt > LOCAL_VOD_OVERRIDE_TTL_MS) {
        changed = true;
        continue;
      }
      next[vodId] = override;
    }
    localVodOverridesCache = next;
    if (changed) writeLocalVodOverrides(next);
  } catch {
    localVodOverridesCache = {};
  }
  return localVodOverridesCache;
};

const writeLocalVodOverrides = (overrides) => {
  localVodOverridesCache = overrides && typeof overrides === "object" ? overrides : {};
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_VOD_OVERRIDES_KEY, JSON.stringify(localVodOverridesCache));
  } catch {
    // no-op
  }
};

const applyLocalVodOverride = (vod) => {
  if (!vod || vod.id == null) return vod;
  const overrides = readLocalVodOverrides();
  const override = overrides[String(vod.id)];
  if (!override || typeof override !== "object") return vod;

  const nextVod = { ...vod };
  if (Object.prototype.hasOwnProperty.call(override, "vodNotice")) {
    if (override.vodNotice) nextVod.vodNotice = override.vodNotice;
    else delete nextVod.vodNotice;
  }
  if (Object.prototype.hasOwnProperty.call(override, "chatReplayAvailable")) {
    nextVod.chatReplayAvailable = Boolean(override.chatReplayAvailable);
  }
  if (Object.prototype.hasOwnProperty.call(override, "unpublished")) {
    nextVod.unpublished = Boolean(override.unpublished);
  }

  return nextVod;
};

const normalizeVodNoticeText = (vod) => {
  if (!vod || !vod.vodNotice) return vod;
  if (vod.vodNotice !== SPOTIFY_NOTICE_OLD) return vod;
  return { ...vod, vodNotice: SPOTIFY_NOTICE_NEW };
};

export const cacheLocalVodOverrideFromVod = (vod) => {
  if (!vod || vod.id == null) return;
  const key = String(vod.id);
  const normalizedNotice = vod.vodNotice === SPOTIFY_NOTICE_OLD ? SPOTIFY_NOTICE_NEW : vod.vodNotice || "";
  const overrides = { ...readLocalVodOverrides() };
  overrides[key] = {
    ...(overrides[key] || {}),
    vodNotice: normalizedNotice,
    chatReplayAvailable: vod.chatReplayAvailable !== false,
    unpublished: Boolean(vod.unpublished),
    savedAt: Date.now(),
  };
  writeLocalVodOverrides(overrides);
};

const normalizeYouTubeEntriesForSite = (entries, archiveDuration) => {
  const source = Array.isArray(entries) ? entries : [];
  const visible = source.filter((entry) => entry?.unpublished !== true);
  const timelineForType = (type) => buildYouTubeTimeline(
    source.filter((entry) => String(entry?.type || "vod") === type && entry?.id), archiveDuration
  );
  const vodEntries = timelineForType("vod")
    .filter((entry) => entry.unpublished !== true)
    .map((entry, index) => ({
      ...entry,
      part: index + 1,
    }));

  const liveEntries = new Map(timelineForType("live").map((entry) => [entry.id, entry]));
  const nonVodEntries = visible.filter((entry) => !(String(entry?.type || "vod") === "vod" && entry?.id))
    .map((entry) => entry?.type === "live" ? liveEntries.get(entry.id) || entry : entry);
  return [...vodEntries, ...nonVodEntries];
};

const normalizeVod = (vod) => {
  const normalized = {
    chapters: [],
    drive: [],
    games: [],
    youtube: [],
    platform: "twitch",
    unpublished: false,
    ...vod,
  };
  normalized.youtube = normalizeYouTubeEntriesForSite(normalized.youtube, normalized.duration);
  // Cache server data independently so an expired local edit can be removed,
  // including when the next metadata request fails and we use the cached copy.
  return normalizeVodNoticeText(normalized);
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw signal.reason || new DOMException("The request was canceled.", "AbortError");
};

const consumeStaticVodsRequest = (request, signal) => new Promise((resolve, reject) => {
  request.readers += 1;
  let finished = false;
  const finish = (callback, value) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    request.readers -= 1;
    if (!request.settled && request.readers === 0) {
      if (staticVodsRequest === request) staticVodsRequest = null;
      request.controller.abort();
    }
    callback(value);
  };
  const onAbort = () => finish(reject, signal.reason || new DOMException("The request was canceled.", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  request.promise.then(value => finish(resolve, value), error => finish(reject, error));
  if (signal?.aborted) onAbort();
});

const loadStaticVods = async ({ forceRefresh = false, signal } = {}) => {
  throwIfAborted(signal);
  if (staticVodsRequest) return consumeStaticVodsRequest(staticVodsRequest, signal);
  if (!forceRefresh && staticVodsCache && Date.now() - staticVodsLoadedAt < STATIC_VODS_CACHE_MS) return staticVodsCache;
  const request = { controller: new AbortController(), readers: 0, settled: false, promise: null };
  staticVodsRequest = request;
  request.promise = (async () => {
    try {
      const response = await fetch(STATIC_DATA_PATH, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`Failed to load static VOD data (${response.status})`);
      const data = await response.json();
      throwIfAborted(request.controller.signal);
      staticVodsCache = Array.isArray(data) ? data.map(normalizeVod) : [];
      staticVodsLoadedAt = Date.now();
      return staticVodsCache;
    } catch (error) {
      throwIfAborted(request.controller.signal);
      if (staticVodsCache) return staticVodsCache;
      throw error;
    } finally {
      request.settled = true;
      if (staticVodsRequest === request) staticVodsRequest = null;
    }
  })();
  return consumeStaticVodsRequest(request, signal);
};

const loadStaticComments = async (vodId) => {
  const key = String(vodId);
  if (staticCommentsCache.has(key)) return staticCommentsCache.get(key);
  if (staticCommentsRequests.has(key)) return staticCommentsRequests.get(key);
  const request = (async () => {
  try {
    const response = await fetch(`${STATIC_COMMENTS_BASE}/${encodeURIComponent(key)}.json`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-cache",
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const comments = Array.isArray(data) ? data : Array.isArray(data.comments) ? data.comments : [];
    staticCommentsCache.set(key, comments);
    // Keep recently viewed logs, without retaining every long stream visited.
    while (staticCommentsCache.size > 3) staticCommentsCache.delete(staticCommentsCache.keys().next().value);
    return comments;
  } catch {
    return [];
  }
  })();
  staticCommentsRequests.set(key, request);
  try {
    return await request;
  } finally {
    staticCommentsRequests.delete(key);
  }
};

const normalizeEmotesPayload = (payload) => ({
  ...DEFAULT_EMOTES,
  ...(payload || {}),
  ffz_emotes: Array.isArray(payload?.ffz_emotes) ? payload.ffz_emotes : [],
  bttv_emotes: Array.isArray(payload?.bttv_emotes) ? payload.bttv_emotes : [],
  "7tv_emotes": Array.isArray(payload?.["7tv_emotes"]) ? payload["7tv_emotes"] : [],
  embedded_emotes: Array.isArray(payload?.embedded_emotes) ? payload.embedded_emotes : [],
});

const normalizeBadgesPayload = (payload) => ({
  ...DEFAULT_BADGES,
  ...(payload || {}),
  channel: Array.isArray(payload?.channel) ? payload.channel : [],
  global: Array.isArray(payload?.global) ? payload.global : [],
});

const loadStaticEmotes = async (vodId) => {
  const key = String(vodId);
  if (staticEmotesCache.has(key)) return staticEmotesCache.get(key);
  if (staticEmotesRequests.has(key)) return staticEmotesRequests.get(key);
  const request = (async () => {
    try {
      const response = await fetch(`${STATIC_EMOTES_BASE}/${encodeURIComponent(key)}.json`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
      });
      if (!response.ok) return DEFAULT_EMOTES;
      const data = await response.json();
      const payload = Array.isArray(data?.data) ? data.data[0] : data;
      const normalized = normalizeEmotesPayload(payload);
      staticEmotesCache.set(key, normalized);
      while (staticEmotesCache.size > 3) staticEmotesCache.delete(staticEmotesCache.keys().next().value);
      return normalized;
    } catch {
      return DEFAULT_EMOTES;
    }
  })();
  staticEmotesRequests.set(key, request);
  try {
    return await request;
  } finally {
    staticEmotesRequests.delete(key);
  }
};

const loadStaticBadges = async () => {
  if (staticBadgesCache) return staticBadgesCache;
  if (staticBadgesRequest) return staticBadgesRequest;
  staticBadgesRequest = (async () => {
    try {
      const response = await fetch(STATIC_BADGES_PATH, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
      });
      if (!response.ok) return DEFAULT_BADGES;
      const data = await response.json();
      staticBadgesCache = normalizeBadgesPayload(data);
      return staticBadgesCache;
    } catch {
      return DEFAULT_BADGES;
    }
  })();
  try {
    return await staticBadgesRequest;
  } finally {
    staticBadgesRequest = null;
  }
};

export const getVodById = async (vodId, options = {}) => {
  throwIfAborted(options.signal);
  if (USE_STATIC_ARCHIVE) {
    const vods = await loadStaticVods(options);
    throwIfAborted(options.signal);
    const match = vods.find((vod) => String(vod.id) === String(vodId));
    const resolvedMatch = match ? normalizeVodNoticeText(applyLocalVodOverride(match)) : match;
    if (resolvedMatch?.unpublished) throw new Error(`VOD ${vodId} is unpublished`);
    if (!resolvedMatch) throw new Error(`VOD ${vodId} not found in static data`);
    return resolvedMatch;
  }

  const response = await fetch(`${VODS_API_BASE}/vods/${vodId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Failed to load VOD (${response.status})`);
  const payload = await response.json();
  throwIfAborted(options.signal);
  if (payload?.unpublished) throw new Error(`VOD ${vodId} is unpublished`);
  return normalizeVodNoticeText(applyLocalVodOverride(normalizeVod(payload)));
};

export const getBadges = async () => {
  if (USE_STATIC_ARCHIVE) return loadStaticBadges();

  const response = await fetch(`${VODS_API_BASE}/v2/badges`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return normalizeBadgesPayload(await response.json());
};

export const getEmotes = async (vodId) => {
  if (USE_STATIC_ARCHIVE) {
    const emotes = await loadStaticEmotes(vodId);
    return { data: [emotes] };
  }

  const response = await fetch(`${VODS_API_BASE}/emotes?vod_id=${vodId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return response.json();
};

export const getVodComments = async (vodId, { cursor, contentOffsetSeconds } = {}) => {
  if (USE_STATIC_ARCHIVE) {
    const comments = await loadStaticComments(vodId);
    if (comments.length === 0) return { comments: [], cursor: null };
    // For the static archive frontend, return the full saved chat log so seeking/delay changes
    // can rebuild history reliably without paging race conditions.
    return { comments, cursor: null };
  }

  const url = new URL(`${VODS_API_BASE}/v1/vods/${vodId}/comments`);
  if (cursor) url.searchParams.set("cursor", cursor);
  if (Number.isFinite(contentOffsetSeconds)) {
    url.searchParams.set("content_offset_seconds", String(contentOffsetSeconds));
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return response.json();
};

export const findVodsStatic = async (query = {}) => {
  const vods = await loadStaticVods();
  let filtered = vods.map(applyLocalVodOverride).filter((vod) => !vod.unpublished);

  if (Array.isArray(query.$and)) {
    for (const condition of query.$and) {
      if (isEmptyObject(condition)) continue;

      if (condition.platform) {
        filtered = filtered.filter((vod) => String(vod.platform || "").toLowerCase() === String(condition.platform).toLowerCase());
      }

      if (condition.createdAt) {
        const min = toComparableDate(condition.createdAt.$gte);
        const max = toComparableDate(condition.createdAt.$lte);
        filtered = filtered.filter((vod) => {
          const created = toComparableDate(vod.createdAt);
          if (Number.isFinite(min) && created < min) return false;
          if (Number.isFinite(max) && created > max) return false;
          return true;
        });
      }

      if (condition.title && condition.title.$iLike) {
        const search = condition.title.$iLike.replace(/%/g, "");
        filtered = filtered.filter((vod) => textMatches(vod.title, search));
      }

      if (condition.chapters && condition.chapters.name) {
        filtered = filtered.filter((vod) => chapterMatches(vod.chapters, condition.chapters.name));
      }
    }
  }

  if (query.chapters && query.chapters.name) {
    filtered = filtered.filter((vod) => chapterMatches(vod.chapters, query.chapters.name));
  }

  if (query.$sort && query.$sort.createdAt) {
    const direction = query.$sort.createdAt < 0 ? -1 : 1;
    filtered.sort((a, b) => (toComparableDate(a.createdAt) - toComparableDate(b.createdAt)) * direction);
  } else {
    filtered.sort((a, b) => toComparableDate(b.createdAt) - toComparableDate(a.createdAt));
  }

  const total = filtered.length;
  const limit = Number.isFinite(query.$limit) ? query.$limit : total;
  const skip = Number.isFinite(query.$skip) ? query.$skip : 0;

  return {
    total,
    limit,
    skip,
    data: filtered.slice(skip, skip + limit),
  };
};
