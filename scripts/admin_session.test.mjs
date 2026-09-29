import test from "node:test";
import assert from "node:assert/strict";
import { createAdminSession } from "../src/api/adminSession.mjs";

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
const fixture = (request) => {
  const tab = storage(), local = storage();
  return { tab, local, session: createAdminSession({ request, getSessionStorage: () => tab, getLocalStorage: () => local }) };
};

test("a rejected session clears its token and immediately notifies the UI", async () => {
  const { tab, session } = fixture(async () => { throw Object.assign(new Error("Session expired"), { status: 401 }); });
  session.setToken("expired");
  const changes = [];
  session.subscribe((change) => changes.push(change));
  await assert.rejects(session.request("/vods", { token: "expired" }), { status: 401 });
  assert.equal(session.getToken(), "");
  assert.equal(tab.getItem("soft_admin_token"), null);
  assert.deepEqual(changes, [{ authenticated: false, reason: "expired" }]);
});

test("a late failure for the old session does not erase a new login", async () => {
  let rejectOld;
  const { session } = fixture(() => new Promise((_, reject) => { rejectOld = reject; }));
  session.setToken("old");
  const pending = session.request("/session", { token: "old" });
  session.setToken("new");
  rejectOld(Object.assign(new Error("Expired"), { status: 401 }));
  await assert.rejects(pending, { status: 401 });
  assert.equal(session.getToken(), "new");
});

test("session verification rechecks a newer login after the old session is rejected", async () => {
  let rejectOld;
  const checked = [];
  const { session } = fixture((_path, { token }) => {
    checked.push(token);
    return token === "old" ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve({ ok: true });
  });
  session.setToken("old");
  const pending = session.verify();
  session.setToken("new");
  rejectOld(Object.assign(new Error("Expired"), { status: 401 }));
  assert.equal(await pending, true);
  assert.deepEqual(checked, ["old", "new"]);
});

test("a verification response received after sign out cannot authorize the page", async () => {
  let finish;
  const { session } = fixture(() => new Promise(resolve => { finish = resolve; }));
  session.setToken("old");
  const pending = session.verify();
  session.clearToken();
  finish({ ok: true });
  assert.equal(await pending, false);
});

test("a disconnected bridge preserves the current session", async () => {
  const { session } = fixture(async () => { throw new Error("Connection lost"); });
  session.setToken("current");
  await assert.rejects(session.request("/session", { token: "current" }), /Connection lost/);
  assert.equal(session.getToken(), "current");
});

test("sign out clears the tab immediately and revokes only its captured token", async () => {
  let finish;
  const calls = [];
  const { session } = fixture((...args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); });
  session.setToken("old");
  const pending = session.signOut();
  assert.equal(session.getToken(), "");
  session.setToken("new");
  finish({ ok: true });
  await pending;
  assert.deepEqual(calls, [["/logout", { method: "POST", token: "old" }]]);
  assert.equal(session.getToken(), "new");
});

test("unavailable browser storage still supports session expiry and sign out", async () => {
  const unavailable = () => { throw new Error("Storage blocked"); };
  const session = createAdminSession({ request: async () => ({ ok: true }), getSessionStorage: unavailable, getLocalStorage: unavailable });
  session.setToken("runtime-only");
  assert.equal(session.getToken(), "runtime-only");
  await session.signOut();
  assert.equal(session.getToken(), "");
});
