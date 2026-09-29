import { cacheLocalVodOverrideFromVod } from "./vodsApi";
import { createAdminTransport } from "./adminTransport.mjs";
import { createAdminSession } from "./adminSession.mjs";

export const isLocalAdminConsole = typeof window !== "undefined" && window.location.pathname.startsWith("/console/");
const ADMIN_API_BASE = (isLocalAdminConsole ? window.location.origin : process.env.REACT_APP_ADMIN_API_BASE || "http://127.0.0.1:49731").replace(/\/+$/, "");
const ADMIN_API_FALLBACK_BASES = Array.from(
  new Set(
    (isLocalAdminConsole ? [ADMIN_API_BASE] : [
      ADMIN_API_BASE,
      "http://localhost:49731",
      "http://127.0.0.1:49731",
      "http://localhost:49721",
      "http://127.0.0.1:49721",
    ])
      .map((value) => String(value || "").replace(/\/+$/, ""))
      .filter(Boolean)
  )
);
const ADMIN_PENDING_PASSWORD_KEY = "soft_admin_pending_password";
const ADMIN_API_WAKE_PROTOCOL = "soft-archive-admin://wake";
const transport = createAdminTransport({ bases: ADMIN_API_FALLBACK_BASES });
const session = createAdminSession({ request: transport.request, getSessionStorage: () => sessionStorage, getLocalStorage: () => localStorage });
export const connectAdmin = () => transport.discover();
export const getLocalAdminUrl = () => `${transport.getBase() || ADMIN_API_BASE}/console/admin`;

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });

const tryWakeAdminApi = () => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  try {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = ADMIN_API_WAKE_PROTOCOL;
    document.body.appendChild(iframe);
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        // no-op
      }
    }, 1500);
  } catch {
    // no-op
  }
};

const tryWakeAdminApiFromGesture = () => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  try {
    const link = document.createElement("a");
    link.href = ADMIN_API_WAKE_PROTOCOL;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  } catch {
    // Fall back to iframe launch below.
  }

  tryWakeAdminApi();
};

export const primeAdminWake = () => {
  tryWakeAdminApiFromGesture();
};

const readAdminToken = session.getToken;
const writeAdminToken = session.setToken;
export const clearAdminToken = session.clearToken;
export const signOutAdmin = session.signOut;
export const subscribeToAdminSession = session.subscribe;

export const setPendingAdminPassword = (password) => {
  const normalized = String(password || "").trim();
  if (!normalized) return;
  try {
    sessionStorage.setItem(ADMIN_PENDING_PASSWORD_KEY, normalized);
  } catch {
    // no-op
  }
};

export const consumePendingAdminPassword = () => {
  let password = "";
  try {
    password = sessionStorage.getItem(ADMIN_PENDING_PASSWORD_KEY) || "";
  } catch {
    // no-op
  }
  if (!password) {
    try {
      password = localStorage.getItem(ADMIN_PENDING_PASSWORD_KEY) || "";
    } catch {
      // no-op
    }
  }
  try {
    sessionStorage.removeItem(ADMIN_PENDING_PASSWORD_KEY);
  } catch {
    // no-op
  }
  try {
    localStorage.removeItem(ADMIN_PENDING_PASSWORD_KEY);
  } catch {
    // no-op
  }
  return String(password || "").trim();
};

export const getAdminToken = () => readAdminToken();

const request = session.request;

export const authenticateAdmin = async (password) => {
  const payload = await request("/auth", {
    method: "POST",
    body: { password },
  });
  if (!payload?.token) throw new Error("Admin API did not return a session token");
  writeAdminToken(payload.token);

  return payload.token;
};

export const verifyAdminSession = session.verify;

export const getAdminVods = async () => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request("/vods", { token });
};

export const getSiteDesignAdmin = async () => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request("/site-design", { token });
};

export const publishSiteDesign = async (design) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request("/site-design", {
    method: "POST",
    token,
    body: { design },
  });
};

export const uploadDesignAsset = async (file) => {
  const token = readAdminToken();
  if (!token) throw new Error("Unlock admin before uploading images");
  if (!file) throw new Error("Choose an image to upload");

  const dataUrl = await readFileAsDataUrl(file);
  return request("/design-assets", {
    method: "POST",
    token,
    body: {
      fileName: file.name,
      contentType: file.type,
      dataUrl,
    },
  });
};

export const setVodNotice = async (vodId, enabled) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/notice`, {
    method: "POST",
    token,
    body: { enabled: Boolean(enabled) },
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const setVodChatReplay = async (vodId, available) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/chat-replay`, {
    method: "POST",
    token,
    body: { available: Boolean(available) },
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const setVodFlags = async (vodId, { noticeEnabled, chatReplayAvailable }) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/flags`, {
    method: "POST",
    token,
    body: {
      noticeEnabled: Boolean(noticeEnabled),
      chatReplayAvailable: Boolean(chatReplayAvailable),
    },
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const unpublishVod = async (vodId) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/unpublish`, {
    method: "POST",
    token,
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const unpublishVodPart = async (vodId, partNumber) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const normalizedPart = Number(partNumber);
  if (!Number.isFinite(normalizedPart) || normalizedPart < 1) {
    throw new Error(`Part number must be a positive integer: ${partNumber}`);
  }
  const payload = await request(
    `/vods/${encodeURIComponent(String(vodId))}/parts/${encodeURIComponent(String(Math.floor(normalizedPart)))}/unpublish`,
    {
      method: "POST",
      token,
    }
  );
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const republishVodPart = async (vodId, partRef) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const normalizedRef = String(partRef || "").trim();
  if (!normalizedRef) throw new Error("Part reference is required");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/parts/${encodeURIComponent(normalizedRef)}/republish`, {
    method: "POST",
    token,
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const republishVod = async (vodId) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  const payload = await request(`/vods/${encodeURIComponent(String(vodId))}/republish`, {
    method: "POST",
    token,
  });
  if (payload?.vod) cacheLocalVodOverrideFromVod(payload.vod);
  return payload;
};

export const promptAndLoginAdmin = async () => {
  const password = window.prompt("Enter admin password");
  if (password == null) return false;
  const normalizedPassword = String(password).trim();
  if (!normalizedPassword) throw new Error("Admin password cannot be empty.");
  await authenticateAdmin(normalizedPassword);
  return true;
};
