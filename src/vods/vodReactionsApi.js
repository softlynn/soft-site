const REACTIONS_API_BASE = String(process.env.REACT_APP_REACTIONS_API_BASE || "https://api.softu.one/v1/reactions")
  .trim()
  .replace(/\/+$/, "");
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 8000;
const VOTE_STORAGE_KEY = "softu-vod-reaction-votes-v1";
const MAX_STORED_VOTES = 2000;

const snapshotCache = new Map();
const inflightLoads = new Map();
const subscribers = new Map();
const sessionVoteMap = new Map();
let votesLoadedFromStorage = false;

const clampCount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
};

const normalizeVodId = (vodId) => String(vodId || "").trim();

const normalizeVote = (vote) => (vote === "like" || vote === "dislike" ? vote : null);

const canUseLocalStorage = () => typeof window !== "undefined" && typeof window.localStorage !== "undefined";

const loadPersistedVotes = () => {
  if (votesLoadedFromStorage) return;
  votesLoadedFromStorage = true;
  if (!canUseLocalStorage()) return;

  try {
    const raw = window.localStorage.getItem(VOTE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    Object.entries(parsed).forEach(([key, value]) => {
      const normalizedKey = normalizeVodId(key);
      const normalized = normalizeVote(value);
      if (normalizedKey && normalized) {
        sessionVoteMap.set(normalizedKey, normalized);
      }
    });
  } catch (_error) {
    // Ignore malformed/blocked storage and fall back to session memory.
  }
};

const persistVotes = () => {
  if (!canUseLocalStorage()) return;
  try {
    const entries = Array.from(sessionVoteMap.entries());
    const trimmed = entries.slice(Math.max(0, entries.length - MAX_STORED_VOTES));
    const payload = Object.fromEntries(trimmed);
    window.localStorage.setItem(VOTE_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // Storage may be blocked/full; keep in-memory behavior.
  }
};

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

const reactionUrl = (key) => `${REACTIONS_API_BASE}/${encodeURIComponent(key)}`;

const readSnapshot = async (key) => {
  const response = await retryableRequest(() =>
    fetchWithTimeout(reactionUrl(key), {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    })
  );

  const payload = await safeReadJson(response);
  if (!response.ok) {
    if (response.status === 404) return { likes: 0, dislikes: 0 };
    throw createHttpError(`Reactions read failed (${response.status})`, response.status, "REACTIONS_READ_HTTP");
  }

  return {
    likes: clampCount(payload?.likes),
    dislikes: clampCount(payload?.dislikes),
  };
};

const writeSnapshot = async (key, nextVote, previousVote) => {
  const response = await retryableRequest(() =>
    fetchWithTimeout(reactionUrl(key), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nextVote, previousVote }),
    })
  );

  const payload = await safeReadJson(response);
  if (!response.ok) {
    throw createHttpError(`Reactions write failed (${response.status})`, response.status, "REACTIONS_WRITE_HTTP");
  }

  return {
    likes: clampCount(payload?.likes),
    dislikes: clampCount(payload?.dislikes),
  };
};

export const getStoredVodReactionVote = (vodId) => {
  loadPersistedVotes();
  const key = normalizeVodId(vodId);
  if (!key) return null;
  const value = sessionVoteMap.get(key);
  return value === "like" || value === "dislike" ? value : null;
};

export const setStoredVodReactionVote = (vodId, vote) => {
  loadPersistedVotes();
  const key = normalizeVodId(vodId);
  if (!key) return;
  if (vote === "like" || vote === "dislike") {
    sessionVoteMap.set(key, vote);
  } else {
    sessionVoteMap.delete(key);
  }
  persistVotes();
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

export const getVodReactionSnapshot = async (vodId, { force = false } = {}) => {
  const key = normalizeVodId(vodId);
  if (!key) return { likes: 0, dislikes: 0, fetchedAt: Date.now() };

  if (!force) {
    const cached = getCachedSnapshot(key);
    if (cached) return cached;
  }

  if (!force && inflightLoads.has(key)) return inflightLoads.get(key);

  const promise = readSnapshot(key)
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
  const snapshot = await getVodReactionSnapshot(key, { force });
  return clampCount(snapshot.likes);
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
    const snapshot = await writeSnapshot(key, normalizedNext, normalizedPrev);
    return cacheSnapshot(key, snapshot);
  } catch (error) {
    // The Worker is the only backend: when it is unreachable, restore the
    // previous vote and counts and let the caller surface the failure.
    setStoredVodReactionVote(key, normalizedPrev);
    cacheSnapshot(key, current);
    throw error;
  }
};
