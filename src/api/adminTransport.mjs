// Discover once using read-only health checks. Never replay a write: the server
// may have completed it even when the response was lost.
export function createAdminTransport({ bases, discoveryTimeoutMs = 1200, requestTimeoutMs = 15000, mutationTimeoutMs = 120000 }) {
  const candidates = [...new Set(bases.filter(Boolean).map((base) => base.replace(/\/+$/, "")))];
  let activeBase = "";
  let discovery = null;

  async function fetchJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
      const payload = response.ok ? await response.json() : await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(payload.error || `Admin request failed (${response.status})`), {
          status: response.status, code: payload.code, authUrl: payload.authUrl, userCode: payload.userCode,
        });
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("The local admin request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function discover() {
    if (activeBase) return activeBase;
    if (!discovery) {
      discovery = Promise.any(candidates.map(async (base) => {
        const payload = await fetchJson(`${base}/health`, {}, discoveryTimeoutMs);
        if (payload?.ok !== true || payload?.service !== "soft-admin-api") throw new Error("Not the admin bridge");
        return base;
      })).then((base) => { activeBase = base; return base; }).catch(() => {
        throw new Error("Could not reach your local admin. Open Softuchive and choose Open admin, or start the local bridge and reconnect.");
      }).finally(() => { discovery = null; });
    }
    return discovery;
  }

  async function request(path, { method = "GET", body, token } = {}) {
    const base = await discover();
    const isWrite = method !== "GET" && method !== "HEAD";
    try {
      return await fetchJson(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, isWrite ? mutationTimeoutMs : requestTimeoutMs);
    } catch (error) {
      if (error.status) throw error;
      activeBase = "";
      if (isWrite) {
        throw new Error(`${error.message || "Connection lost"} The change may have completed. Refresh the VOD or design before trying again.`, { cause: error });
      }
      throw error;
    }
  }

  return { request, discover, getBase: () => activeBase };
}
