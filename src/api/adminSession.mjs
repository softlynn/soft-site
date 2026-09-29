const TOKEN_KEY = "soft_admin_token";
const HANDOFF_KEY = "soft_admin_token_handoff";

export function createAdminSession({ request: send, getSessionStorage, getLocalStorage }) {
  let runtimeToken = "";
  const listeners = new Set();
  const notify = (reason) => {
    for (const listener of listeners) listener({ authenticated: Boolean(runtimeToken), reason });
  };
  const getToken = () => {
    if (runtimeToken) return runtimeToken;
    try { runtimeToken = getSessionStorage().getItem(TOKEN_KEY) || ""; } catch { /* Storage can be blocked. */ }
    if (runtimeToken) return runtimeToken;
    try {
      runtimeToken = getLocalStorage().getItem(HANDOFF_KEY) || "";
      if (runtimeToken) {
        try { getSessionStorage().setItem(TOKEN_KEY, runtimeToken); } catch { /* Keep the runtime token. */ }
        getLocalStorage().removeItem(HANDOFF_KEY);
      }
    } catch { /* Storage can be blocked. */ }
    return runtimeToken;
  };
  const setToken = (token) => {
    runtimeToken = String(token || "");
    try { getSessionStorage().setItem(TOKEN_KEY, runtimeToken); } catch { /* Keep the runtime token. */ }
    notify("signed-in");
  };
  const clearToken = (reason = "signed-out") => {
    runtimeToken = "";
    try { getSessionStorage().removeItem(TOKEN_KEY); } catch { /* Storage can be blocked. */ }
    try { getLocalStorage().removeItem(HANDOFF_KEY); } catch { /* Storage can be blocked. */ }
    notify(reason);
  };
  const request = async (path, options = {}) => {
    try {
      return await send(path, options);
    } catch (error) {
      // A response for a previous login must not clear a newer session.
      if (error.status === 401 && options.token && options.token === getToken()) clearToken("expired");
      throw error;
    }
  };
  const signOut = async () => {
    const token = getToken();
    clearToken();
    if (!token) return;
    try { await send("/logout", { method: "POST", token }); }
    catch (error) { if (error.status !== 401) throw error; }
  };
  const verify = async () => {
    const token = getToken();
    if (!token) return false;
    try {
      await request("/session", { token });
      return getToken() === token ? true : verify();
    } catch (error) {
      if (getToken() && getToken() !== token) return verify();
      if (error.status === 401 || !getToken()) return false;
      throw error;
    }
  };
  return {
    getToken, setToken, clearToken, request, signOut, verify,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
