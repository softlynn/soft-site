const ADMIN_API_BASE = (process.env.REACT_APP_ADMIN_API_BASE || "http://localhost:49731").replace(/\/+$/, "");
const ADMIN_API_FALLBACK_BASES = Array.from(
  new Set(
    [
      ADMIN_API_BASE,
      "http://localhost:49731",
      "http://127.0.0.1:49731",
      "http://localhost:49721",
      "http://127.0.0.1:49721",
    ]
      .map((value) => String(value || "").replace(/\/+$/, ""))
      .filter(Boolean)
  )
);
const ADMIN_TOKEN_KEY = "soft_admin_token";
let runtimeAdminToken = "";
const ADMIN_API_STARTUP_RETRY_MS = 12000;
const ADMIN_API_STARTUP_RETRY_DELAY_MS = 1200;
const ADMIN_API_WAKE_PROTOCOL = "soft-archive-admin://wake";

const buildUrl = (base, path) => `${base}${path.startsWith("/") ? path : `/${path}`}`;
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isNetworkStartupError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  if (!message) return false;
  return message.includes("failed to fetch") || message.includes("networkerror");
};

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

const readAdminToken = () => {
  if (runtimeAdminToken) return runtimeAdminToken;
  try {
    const stored = sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
    if (stored) runtimeAdminToken = stored;
    return stored;
  } catch {
    return "";
  }
};

const writeAdminToken = (token) => {
  runtimeAdminToken = String(token || "");
  if (!runtimeAdminToken) return;
  try {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, runtimeAdminToken);
  } catch {
    // Keep runtime fallback when storage is unavailable.
  }
};

export const clearAdminToken = () => {
  runtimeAdminToken = "";
  try {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // no-op
  }
};

export const getAdminToken = () => readAdminToken();

const request = async (path, { method = "GET", body, token } = {}) => {
  let lastError = null;
  const deadline = Date.now() + ADMIN_API_STARTUP_RETRY_MS;
  let wakeAttempted = false;

  while (true) {
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
          if (payload?.userCode) error.userCode = payload.userCode;
          throw error;
        }
        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    if (!isNetworkStartupError(lastError) || Date.now() >= deadline) break;
    if (!wakeAttempted) {
      wakeAttempted = true;
      tryWakeAdminApi();
    }
    await sleep(ADMIN_API_STARTUP_RETRY_DELAY_MS);
  }

  const message = lastError?.message || "Failed to reach local admin API";
  throw new Error(`${message}. If needed, start it with 'npm run admin:api:wake' (or start-admin-api.cmd), then retry.`);
};

export const authenticateAdmin = async (password) => {
  const payload = await request("/auth", {
    method: "POST",
    body: { password },
  });
  if (!payload?.token) throw new Error("Admin API did not return a session token");
  writeAdminToken(payload.token);

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
  if (password == null) return false;
  if (!String(password).trim()) throw new Error("Admin password cannot be empty.");
  await authenticateAdmin(password);
  return true;
};
