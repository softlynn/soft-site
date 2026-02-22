const COUNTER_API_BASE = "https://api.counterapi.dev/v1";
const COUNTER_NAMESPACE = "softu-vod-reactions-v1";
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_GAP_MS = 550;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 8000;

const snapshotCache = new Map();
const inflightLoads = new Map();
const subscribers = new Map();
let requestChain = Promise.resolve();
let nextRequestAt = 0;
let writeRequestChain = Promise.resolve();
let nextWriteRequestAt = 0;
const sessionVoteMap = new Map();

const clampCount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
};

const normalizeVodId = (vodId) => String(vodId || "").trim();

const sanitizeKeyPart = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

const counterKeyFor = (vodId, type) => `${sanitizeKeyPart(vodId)}-${type}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, options) => {
  if (typeof AbortController === "undefined") {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const isRetryableNetworkError = (error) => {
  if (!error) return false;
  const name = String(error.name || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  return name === "aborterror" || message.includes("failed to fetch") || message.includes("networkerror");
};

const enqueueCounterRequest = (factory) => {
  const run = async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
    return factory();
  };

  const queued = requestChain.then(run, run);
  requestChain = queued.catch(() => undefined);
  return queued;
};

const enqueueCounterWriteRequest = (factory) => {
  const run = async () => {
    const wait = Math.max(0, nextWriteRequestAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextWriteRequestAt = Date.now() + REQUEST_GAP_MS;
    return factory();
  };

  const queued = writeRequestChain.then(run, run);
  writeRequestChain = queued.catch(() => undefined);
  return queued;
};

const retryableCounterRequest = async (factory, attempt = 0) => {
  try {
    const response = await factory();
    if (response.status !== 429 && response.status < 500) {
      return response;
    }

    if (attempt >= MAX_RETRIES) {
      return response;
    }

    const retryAfterHeader = Number(response.headers?.get?.("retry-after"));
    const retryDelay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 1200 * (attempt + 1);
    await sleep(retryDelay);
    return retryableCounterRequest(factory, attempt + 1);
  } catch (error) {
    if (!isRetryableNetworkError(error) || attempt >= MAX_RETRIES) {
      throw error;
    }
    await sleep(900 * (attempt + 1));
    return retryableCounterRequest(factory, attempt + 1);
  }
};

export const getStoredVodReactionVote = (vodId) => {
  const key = normalizeVodId(vodId);
  if (!key) return null;
  const value = sessionVoteMap.get(key);
  return value === "like" || value === "dislike" ? value : null;
};

export const setStoredVodReactionVote = (vodId, vote) => {
  const key = normalizeVodId(vodId);
  if (!key) return;
  if (vote === "like" || vote === "dislike") {
    sessionVoteMap.set(key, vote);
  } else {
    sessionVoteMap.delete(key);
  }
};

const emitSnapshot = (vodId, snapshot) => {
  const key = normalizeVodId(vodId);
  if (!key) return;
  const listeners = subscribers.get(key);
  if (!listeners || listeners.size === 0) return;
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("softu reactions subscriber failed:", error);
    }
  });
};

export const subscribeVodReactionSnapshot = (vodId, listener) => {
  const key = normalizeVodId(vodId);
  if (!key || typeof listener !== "function") return () => {};
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(listener);
  return () => {
    const currentSet = subscribers.get(key);
    if (!currentSet) return;
    currentSet.delete(listener);
    if (currentSet.size === 0) subscribers.delete(key);
  };
};

const cacheSnapshot = (vodId, snapshot) => {
  const key = normalizeVodId(vodId);
  if (!key) return snapshot;
  const normalized = {
    likes: clampCount(snapshot?.likes),
    dislikes: clampCount(snapshot?.dislikes),
    fetchedAt: Date.now(),
  };
  snapshotCache.set(key, normalized);
  emitSnapshot(key, normalized);
  return normalized;
};

const getCachedSnapshot = (vodId) => {
  const key = normalizeVodId(vodId);
  if (!key) return null;
  const snapshot = snapshotCache.get(key);
  if (!snapshot) return null;
  if (Date.now() - snapshot.fetchedAt > CACHE_TTL_MS) return null;
  return snapshot;
};

const readCounter = async (key) => {
  return enqueueCounterRequest(async () => {
    const url = `${COUNTER_API_BASE}/${encodeURIComponent(COUNTER_NAMESPACE)}/${encodeURIComponent(key)}`;
    const response = await retryableCounterRequest(() =>
      fetchWithTimeout(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      })
    );

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = String(payload?.message || "").toLowerCase();
      if (response.status === 404 || (response.status === 400 && message.includes("record not found"))) {
        return 0;
      }
      const error = new Error(`Counter read failed (${response.status})`);
      error.code = "COUNTER_READ_HTTP";
      error.status = response.status;
      throw error;
    }

    return clampCount(payload?.count);
  });
};

const mutateCounter = async (key, operation) => {
  return enqueueCounterWriteRequest(async () => {
    const url = `${COUNTER_API_BASE}/${encodeURIComponent(COUNTER_NAMESPACE)}/${encodeURIComponent(key)}/${operation}`;
    const response = await retryableCounterRequest(() =>
      fetchWithTimeout(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      })
    );
    if (!response.ok) {
      const error = new Error(`Counter ${operation} failed (${response.status})`);
      error.code = "COUNTER_WRITE_HTTP";
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    return clampCount(payload?.count);
  });
};

export const getVodReactionSnapshot = async (vodId, { force = false } = {}) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0, fetchedAt: Date.now() };

  if (!force) {
    const cached = getCachedSnapshot(key);
    if (cached) return cached;
  }

  if (!force && inflightLoads.has(key)) return inflightLoads.get(key);

  const promise = Promise.all([readCounter(counterKeyFor(key, "like")), readCounter(counterKeyFor(key, "dislike"))])
    .then(([likes, dislikes]) => cacheSnapshot(key, { likes, dislikes }))
    .finally(() => {
      inflightLoads.delete(key);
    });

  inflightLoads.set(key, promise);
  return promise;
};

export const getVodLikeCount = async (vodId, { force = false } = {}) => {
  const key = normalizeVodId(vodId);
  if (!key) return 0;
  if (!force) {
    const cached = getCachedSnapshot(key);
    if (cached) return clampCount(cached.likes);
  }

  const likes = await readCounter(counterKeyFor(key, "like"));
  const previous = snapshotCache.get(key);
  cacheSnapshot(key, {
    likes,
    dislikes: previous?.dislikes ?? 0,
  });
  return likes;
};

const applyVoteDelta = (snapshot, previousVote, nextVote) => {
  let likes = clampCount(snapshot?.likes);
  let dislikes = clampCount(snapshot?.dislikes);

  if (previousVote === "like" && nextVote !== "like") likes = clampCount(likes - 1);
  if (previousVote === "dislike" && nextVote !== "dislike") dislikes = clampCount(dislikes - 1);
  if (nextVote === "like" && previousVote !== "like") likes = clampCount(likes + 1);
  if (nextVote === "dislike" && previousVote !== "dislike") dislikes = clampCount(dislikes + 1);

  return { likes, dislikes, fetchedAt: Date.now() };
};

export const setVodReactionVote = async (vodId, nextVote, previousVote) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0, fetchedAt: Date.now() };

  const normalizedNext = nextVote === "like" || nextVote === "dislike" ? nextVote : null;
  const normalizedPrev = previousVote === "like" || previousVote === "dislike" ? previousVote : null;

  const current = getCachedSnapshot(key) || { likes: 0, dislikes: 0, fetchedAt: Date.now() };
  cacheSnapshot(key, applyVoteDelta(current, normalizedPrev, normalizedNext));
  setStoredVodReactionVote(key, normalizedNext);

  try {
    let likes = clampCount(current.likes);
    let dislikes = clampCount(current.dislikes);
    if (normalizedPrev === "like" && normalizedNext !== "like" && likes > 0) {
      likes = await mutateCounter(counterKeyFor(key, "like"), "down");
    }
    if (normalizedPrev === "dislike" && normalizedNext !== "dislike" && dislikes > 0) {
      dislikes = await mutateCounter(counterKeyFor(key, "dislike"), "down");
    }
    if (normalizedNext === "like" && normalizedPrev !== "like") {
      likes = await mutateCounter(counterKeyFor(key, "like"), "up");
    }
    if (normalizedNext === "dislike" && normalizedPrev !== "dislike") {
      dislikes = await mutateCounter(counterKeyFor(key, "dislike"), "up");
    }

    return cacheSnapshot(key, { likes, dislikes });
  } catch (error) {
    setStoredVodReactionVote(key, normalizedPrev);
    cacheSnapshot(key, current);
    throw error;
  }
};
