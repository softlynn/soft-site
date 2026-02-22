const COUNTER_API_BASE = "https://api.counterapi.dev/v1";
const COUNTER_NAMESPACE = "softu-vod-reactions-v1";
const PRIMARY_REACTIONS_API_BASE = String(process.env.REACT_APP_REACTIONS_API_BASE || "https://api.softu.one/v1/reactions")
  .trim()
  .replace(/\/+$/, "");
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_GAP_MS = 550;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 8000;
const PRIMARY_HEALTH_TIMEOUT_MS = 1800;
const PRIMARY_MODE_CACHE_MS = 5 * 60 * 1000;

const snapshotCache = new Map();
const inflightLoads = new Map();
const subscribers = new Map();
let requestChain = Promise.resolve();
let nextRequestAt = 0;
let writeRequestChain = Promise.resolve();
let nextWriteRequestAt = 0;
const sessionVoteMap = new Map();
let backendModeCache = null;
let backendModeCheckedAt = 0;

const clampCount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
};

const normalizeVodId = (vodId) => String(vodId || "").trim();

const normalizeVote = (vote) => (vote === "like" || vote === "dislike" ? vote : null);

const sanitizeKeyPart = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

const counterKeyFor = (vodId, type) => `${sanitizeKeyPart(vodId)}-${type}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createHttpError = (message, status, code) => {
  const error = new Error(message);
  error.status = Number(status) || 0;
  error.code = code || "HTTP_ERROR";
  return error;
};

const fetchWithTimeout = async (url, options, timeoutMs = FETCH_TIMEOUT_MS) => {
  if (typeof AbortController === "undefined") {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const safeReadJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
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

const retryableRequest = async (factory, attempt = 0) => {
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
    return retryableRequest(factory, attempt + 1);
  } catch (error) {
    if (!isRetryableNetworkError(error) || attempt >= MAX_RETRIES) {
      throw error;
    }
    await sleep(900 * (attempt + 1));
    return retryableRequest(factory, attempt + 1);
  }
};

const hasPrimaryBackendConfigured = () => PRIMARY_REACTIONS_API_BASE.length > 0;

const markBackendMode = (mode) => {
  backendModeCache = mode;
  backendModeCheckedAt = Date.now();
  return mode;
};

const shouldRefreshBackendMode = () => !backendModeCache || Date.now() - backendModeCheckedAt > PRIMARY_MODE_CACHE_MS;

const getPreferredBackendMode = async () => {
  if (!hasPrimaryBackendConfigured()) return "counter";
  if (!shouldRefreshBackendMode()) return backendModeCache;

  try {
    const response = await retryableRequest(() =>
      fetchWithTimeout(
        `${PRIMARY_REACTIONS_API_BASE}/_health`,
        {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
        },
        PRIMARY_HEALTH_TIMEOUT_MS
      )
    );

    if (!response.ok) {
      return markBackendMode("counter");
    }

    const payload = await safeReadJson(response);
    if (payload?.ok) {
      return markBackendMode("primary");
    }

    return markBackendMode("counter");
  } catch {
    return markBackendMode("counter");
  }
};

const isPrimaryUnavailableError = (error) => {
  if (!error) return false;
  if (isRetryableNetworkError(error)) return true;
  const status = Number(error.status || 0);
  return status === 404 || status === 405 || status === 501;
};

const readPrimarySnapshot = async (vodId) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0 };

  const response = await retryableRequest(() =>
    fetchWithTimeout(`${PRIMARY_REACTIONS_API_BASE}/${encodeURIComponent(key)}`, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    })
  );

  const payload = await safeReadJson(response);
  if (!response.ok) {
    if (response.status === 404) return { likes: 0, dislikes: 0 };
    throw createHttpError(`Primary reactions read failed (${response.status})`, response.status, "PRIMARY_READ_HTTP");
  }

  return {
    likes: clampCount(payload?.likes),
    dislikes: clampCount(payload?.dislikes),
  };
};

const writePrimarySnapshot = async (vodId, nextVote, previousVote) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0 };

  const response = await retryableRequest(() =>
    fetchWithTimeout(`${PRIMARY_REACTIONS_API_BASE}/${encodeURIComponent(key)}`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nextVote: normalizeVote(nextVote),
        previousVote: normalizeVote(previousVote),
      }),
    })
  );

  const payload = await safeReadJson(response);
  if (!response.ok) {
    throw createHttpError(`Primary reactions write failed (${response.status})`, response.status, "PRIMARY_WRITE_HTTP");
  }

  return {
    likes: clampCount(payload?.likes),
    dislikes: clampCount(payload?.dislikes),
  };
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
    const response = await retryableRequest(() =>
      fetchWithTimeout(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      })
    );

    const payload = await safeReadJson(response);
    if (!response.ok) {
      const message = String(payload?.message || "").toLowerCase();
      if (response.status === 404 || (response.status === 400 && message.includes("record not found"))) {
        return 0;
      }
      throw createHttpError(`Counter read failed (${response.status})`, response.status, "COUNTER_READ_HTTP");
    }

    return clampCount(payload?.count);
  });
};

const mutateCounter = async (key, operation) => {
  return enqueueCounterWriteRequest(async () => {
    const url = `${COUNTER_API_BASE}/${encodeURIComponent(COUNTER_NAMESPACE)}/${encodeURIComponent(key)}/${operation}`;
    const response = await retryableRequest(() =>
      fetchWithTimeout(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      })
    );

    if (!response.ok) {
      throw createHttpError(`Counter ${operation} failed (${response.status})`, response.status, "COUNTER_WRITE_HTTP");
    }
    const payload = await safeReadJson(response);
    return clampCount(payload?.count);
  });
};

const readSnapshotByBackend = async (vodId) => {
  const backendMode = await getPreferredBackendMode();
  if (backendMode === "primary") {
    try {
      return await readPrimarySnapshot(vodId);
    } catch (error) {
      if (isPrimaryUnavailableError(error)) {
        markBackendMode("counter");
      } else {
        throw error;
      }
    }
  }

  const key = normalizeVodId(vodId);
  const [likes, dislikes] = await Promise.all([readCounter(counterKeyFor(key, "like")), readCounter(counterKeyFor(key, "dislike"))]);
  return { likes, dislikes };
};

export const getVodReactionSnapshot = async (vodId, { force = false } = {}) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0, fetchedAt: Date.now() };

  if (!force) {
    const cached = getCachedSnapshot(key);
    if (cached) return cached;
  }

  if (!force && inflightLoads.has(key)) return inflightLoads.get(key);

  const promise = readSnapshotByBackend(key)
    .then((snapshot) => cacheSnapshot(key, snapshot))
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

  const backendMode = await getPreferredBackendMode();
  if (backendMode === "primary") {
    try {
      const snapshot = await readPrimarySnapshot(key);
      cacheSnapshot(key, snapshot);
      return clampCount(snapshot.likes);
    } catch (error) {
      if (isPrimaryUnavailableError(error)) {
        markBackendMode("counter");
      } else {
        throw error;
      }
    }
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

  const normalizedNext = normalizeVote(nextVote);
  const normalizedPrev = normalizeVote(previousVote);

  const current = getCachedSnapshot(key) || { likes: 0, dislikes: 0, fetchedAt: Date.now() };
  cacheSnapshot(key, applyVoteDelta(current, normalizedPrev, normalizedNext));
  setStoredVodReactionVote(key, normalizedNext);

  try {
    const backendMode = await getPreferredBackendMode();
    if (backendMode === "primary") {
      const snapshot = await writePrimarySnapshot(key, normalizedNext, normalizedPrev);
      return cacheSnapshot(key, snapshot);
    }

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
    if (isPrimaryUnavailableError(error)) {
      markBackendMode("counter");
    }
    setStoredVodReactionVote(key, normalizedPrev);
    cacheSnapshot(key, current);
    throw error;
  }
};
