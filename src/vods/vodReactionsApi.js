const COUNTER_API_BASE = "https://api.counterapi.dev/v1";
const COUNTER_NAMESPACE = "softu-vod-reactions-v1";
const LOCAL_VOTE_STORAGE_KEY = "softu-vod-reactions-votes";
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_GAP_MS = 550;

const snapshotCache = new Map();
const inflightLoads = new Map();
const subscribers = new Map();
let requestChain = Promise.resolve();
let nextRequestAt = 0;

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

const readVoteMap = () => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_VOTE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeVoteMap = (voteMap) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_VOTE_STORAGE_KEY, JSON.stringify(voteMap || {}));
  } catch {}
};

export const getStoredVodReactionVote = (vodId) => {
  const key = normalizeVodId(vodId);
  if (!key) return null;
  const value = readVoteMap()[key];
  return value === "like" || value === "dislike" ? value : null;
};

export const setStoredVodReactionVote = (vodId, vote) => {
  const key = normalizeVodId(vodId);
  if (!key) return;
  const voteMap = readVoteMap();
  if (vote === "like" || vote === "dislike") {
    voteMap[key] = vote;
  } else {
    delete voteMap[key];
  }
  writeVoteMap(voteMap);
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
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });

    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`Counter read failed (${response.status})`);

    const payload = await response.json();
    return clampCount(payload?.count);
  });
};

const mutateCounter = async (key, operation) => {
  return enqueueCounterRequest(async () => {
    const url = `${COUNTER_API_BASE}/${encodeURIComponent(COUNTER_NAMESPACE)}/${encodeURIComponent(key)}/${operation}`;
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Counter ${operation} failed (${response.status})`);
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

  const current = (await getVodReactionSnapshot(key).catch(() => null)) || { likes: 0, dislikes: 0, fetchedAt: Date.now() };
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
    await getVodReactionSnapshot(key, { force: true }).catch(() => {
      cacheSnapshot(key, current);
    });
    throw error;
  }
};
