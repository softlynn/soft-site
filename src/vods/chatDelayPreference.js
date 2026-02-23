import { DEFAULT_CHAT_DELAY_SECONDS } from "../config/site";

const CHAT_DELAY_STORAGE_KEY = "softu-chat-delay-seconds";
const CHAT_DELAY_MIN = -600;
const CHAT_DELAY_MAX = 600;

const normalizeChatDelay = (value, fallback = DEFAULT_CHAT_DELAY_SECONDS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.round(Number(fallback) || 0);
  return Math.max(CHAT_DELAY_MIN, Math.min(CHAT_DELAY_MAX, Math.round(parsed)));
};

export const getStoredChatDelaySeconds = () => {
  if (typeof window === "undefined") return normalizeChatDelay(DEFAULT_CHAT_DELAY_SECONDS);
  try {
    const stored = window.localStorage.getItem(CHAT_DELAY_STORAGE_KEY);
    if (stored == null || stored === "") return normalizeChatDelay(DEFAULT_CHAT_DELAY_SECONDS);
    return normalizeChatDelay(stored, DEFAULT_CHAT_DELAY_SECONDS);
  } catch {
    return normalizeChatDelay(DEFAULT_CHAT_DELAY_SECONDS);
  }
};

export const setStoredChatDelaySeconds = (value) => {
  const normalized = normalizeChatDelay(value, DEFAULT_CHAT_DELAY_SECONDS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CHAT_DELAY_STORAGE_KEY, String(normalized));
    } catch {
      // no-op
    }
  }
  return normalized;
};

export const getChatDelayBounds = () => ({ min: CHAT_DELAY_MIN, max: CHAT_DELAY_MAX });
