const cleanUrl = (url) => (url ? url.replace(/\/+$/, "") : "");

export const BRAND_NAME = process.env.REACT_APP_BRAND_NAME || "soft";
export const SITE_TITLE = process.env.REACT_APP_SITE_TITLE || `${BRAND_NAME} Archive`;
export const SITE_DESCRIPTION = process.env.REACT_APP_SITE_DESCRIPTION || `Watch all of ${BRAND_NAME}'s VODs with Chat Replay.`;

export const VODS_API_BASE = cleanUrl(process.env.REACT_APP_VODS_API_BASE || "");
export const CDN_BASE = cleanUrl(process.env.REACT_APP_CDN_BASE || "");
export const BTTV_EMOTE_CDN = cleanUrl(process.env.REACT_APP_BTTV_EMOTE_CDN || "https://cdn.betterttv.net/emote");
export const USE_STATIC_ARCHIVE = process.env.REACT_APP_USE_STATIC_ARCHIVE === "true" || !VODS_API_BASE;

export const GITHUB_REPO = cleanUrl(process.env.REACT_APP_GITHUB || "");
export const GITHUB_ISSUES_URL = GITHUB_REPO ? `${GITHUB_REPO}/issues` : "";

export const SOCIAL_LINKS = {
  reddit: process.env.REACT_APP_REDDIT_URL || "",
  youtube: process.env.REACT_APP_YOUTUBE_URL || "",
  discord: process.env.REACT_APP_DISCORD_URL || "",
  twitter: process.env.REACT_APP_TWITTER_URL || "",
  twitch: process.env.REACT_APP_TWITCH_URL || "",
};

export const START_DATE = process.env.REACT_APP_START_DATE || "2022-01-01";
export const DEFAULT_DELAY = Number(process.env.REACT_APP_DEFAULT_DELAY || "0");

export const ENABLE_ADSENSE = process.env.REACT_APP_ENABLE_ADSENSE === "true";
export const ADSENSE_CLIENT = process.env.REACT_APP_ADSENSE_CLIENT || "";
export const ADSENSE_SLOT = process.env.REACT_APP_ADSENSE_SLOT || "";

export const FOOTER_CREDIT = process.env.REACT_APP_FOOTER_CREDIT || "";
export const FOOTER_CREDIT_URL = process.env.REACT_APP_FOOTER_CREDIT_URL || "";
