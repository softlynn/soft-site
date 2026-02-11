const ADMIN_API_BASE = (process.env.REACT_APP_ADMIN_API_BASE || "http://localhost:49721").replace(/\/+$/, "");
const ADMIN_API_FALLBACK_BASES = Array.from(
  new Set(
    [ADMIN_API_BASE, "http://localhost:49721"]
      .map((value) => String(value || "").replace(/\/+$/, ""))
      .filter(Boolean)
  )
);
const ADMIN_TOKEN_KEY = "soft_admin_token";

const buildUrl = (base, path) => `${base}${path.startsWith("/") ? path : `/${path}`}`;

const readAdminToken = () => {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
  } catch {
    return "";
  }
};

export const clearAdminToken = () => {
  try {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // no-op
  }
};

export const getAdminToken = () => readAdminToken();

const request = async (path, { method = "GET", body, token } = {}) => {
  let lastError = null;

  for (const base of ADMIN_API_FALLBACK_BASES) {
    try {
      const response = await fetch(buildUrl(base, path), {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.error || `Admin API request failed (${response.status})`;
        const error = new Error(message);
        if (payload?.code) error.code = payload.code;
        if (payload?.authUrl) error.authUrl = payload.authUrl;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError?.message || "Failed to reach local admin API";
  throw new Error(`${message}. Ensure local admin API is running on port 49721.`);
};

export const authenticateAdmin = async (password) => {
  const payload = await request("/auth", {
    method: "POST",
    body: { password },
  });
  if (!payload?.token) throw new Error("Admin API did not return a session token");

  try {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
  } catch {
    // no-op
  }

  return payload.token;
};

export const verifyAdminSession = async () => {
  const token = readAdminToken();
  if (!token) return false;

  try {
    await request("/session", { token });
    return true;
  } catch {
    clearAdminToken();
    return false;
  }
};

export const getAdminVods = async () => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request("/vods", { token });
};

export const setVodNotice = async (vodId, enabled) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request(`/vods/${encodeURIComponent(String(vodId))}/notice`, {
    method: "POST",
    token,
    body: { enabled: Boolean(enabled) },
  });
};

export const setVodChatReplay = async (vodId, available) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request(`/vods/${encodeURIComponent(String(vodId))}/chat-replay`, {
    method: "POST",
    token,
    body: { available: Boolean(available) },
  });
};

export const unpublishVod = async (vodId) => {
  const token = readAdminToken();
  if (!token) throw new Error("Admin session is missing");
  return request(`/vods/${encodeURIComponent(String(vodId))}/unpublish`, {
    method: "POST",
    token,
  });
};

export const promptAndLoginAdmin = async () => {
  const password = window.prompt("Enter admin password");
  if (!password) return false;
  await authenticateAdmin(password);
  return true;
};
