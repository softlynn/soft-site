import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";

const STATIC_DATA_PATH = `${process.env.PUBLIC_URL || ""}/data/vods.json`;
const STATIC_COMMENTS_BASE = `${process.env.PUBLIC_URL || ""}/data/comments`;
const STATIC_EMOTES_BASE = `${process.env.PUBLIC_URL || ""}/data/emotes`;
const STATIC_COMMENTS_PAGE_SIZE = 600;

let staticVodsCache = null;
const staticCommentsCache = new Map();
const staticEmotesCache = new Map();

const DEFAULT_EMOTES = {
  ffz_emotes: [],
  bttv_emotes: [],
  "7tv_emotes": [],
  embedded_emotes: [],
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

const normalizeVod = (vod) => ({
  chapters: [],
  drive: [],
  games: [],
  youtube: [],
  platform: "twitch",
  ...vod,
});

const loadStaticVods = async () => {
  if (staticVodsCache) return staticVodsCache;
  const response = await fetch(STATIC_DATA_PATH, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = await response.json();
  staticVodsCache = Array.isArray(data) ? data.map(normalizeVod) : [];
  return staticVodsCache;
};

const loadStaticComments = async (vodId) => {
  const key = String(vodId);
  if (staticCommentsCache.has(key)) return staticCommentsCache.get(key);

  try {
    const response = await fetch(`${STATIC_COMMENTS_BASE}/${encodeURIComponent(key)}.json`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      staticCommentsCache.set(key, []);
      return [];
    }

    const data = await response.json();
    const comments = Array.isArray(data) ? data : Array.isArray(data.comments) ? data.comments : [];
    staticCommentsCache.set(key, comments);
    return comments;
  } catch {
    staticCommentsCache.set(key, []);
    return [];
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

const loadStaticEmotes = async (vodId) => {
  const key = String(vodId);
  if (staticEmotesCache.has(key)) return staticEmotesCache.get(key);

  try {
    const response = await fetch(`${STATIC_EMOTES_BASE}/${encodeURIComponent(key)}.json`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      staticEmotesCache.set(key, DEFAULT_EMOTES);
      return DEFAULT_EMOTES;
    }

    const data = await response.json();
    const payload = Array.isArray(data?.data) ? data.data[0] : data;
    const normalized = normalizeEmotesPayload(payload);
    staticEmotesCache.set(key, normalized);
    return normalized;
  } catch {
    staticEmotesCache.set(key, DEFAULT_EMOTES);
    return DEFAULT_EMOTES;
  }
};

export const getVodById = async (vodId) => {
  if (USE_STATIC_ARCHIVE) {
    const vods = await loadStaticVods();
    const match = vods.find((vod) => String(vod.id) === String(vodId));
    if (!match) throw new Error(`VOD ${vodId} not found in static data`);
    return match;
  }

  const response = await fetch(`${VODS_API_BASE}/vods/${vodId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return response.json();
};

export const getBadges = async () => {
  if (USE_STATIC_ARCHIVE) return { channel: [], global: [] };

  const response = await fetch(`${VODS_API_BASE}/v2/badges`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return response.json();
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

    let startIndex = 0;

    if (Number.isFinite(contentOffsetSeconds)) {
      startIndex = comments.length;
      for (let i = 0; i < comments.length; i++) {
        if ((comments[i].content_offset_seconds || 0) >= contentOffsetSeconds) {
          startIndex = i;
          break;
        }
      }
    } else if (cursor) {
      const parsedCursor = Number(cursor);
      if (Number.isFinite(parsedCursor) && parsedCursor >= 0) {
        startIndex = parsedCursor;
      }
    }

    const nextIndex = startIndex + STATIC_COMMENTS_PAGE_SIZE;
    const slice = comments.slice(startIndex, nextIndex);
    const nextCursor = nextIndex < comments.length ? String(nextIndex) : null;

    return { comments: slice, cursor: nextCursor };
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
  let filtered = [...vods];

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
