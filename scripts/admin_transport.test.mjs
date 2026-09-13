import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAdminTransport } from "../src/api/adminTransport.mjs";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

test("admin errors preserve their status and actionable details", async (t) => {
  const base = await fixture(t, (req, res) => req.url === "/health"
    ? json(res, 200, { ok: true, service: "soft-admin-api" })
    : json(res, 401, { error: "Session expired", code: "SESSION_EXPIRED" }));
  const transport = createAdminTransport({ bases: [base] });
  await assert.rejects(transport.request("/session"), (error) => error.status === 401 && error.code === "SESSION_EXPIRED");
});

test("a mutation whose response is lost is never replayed", async (t) => {
  let writes = 0;
  const base = await fixture(t, (req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true, service: "soft-admin-api" });
    if (req.method !== "POST") return json(res, 404, { error: "Not found" });
    writes += 1;
    req.socket.destroy();
  });
  const transport = createAdminTransport({ bases: [base, `${base}/other`], requestTimeoutMs: 100 });
  await assert.rejects(transport.request("/vods/1/flags", { method: "POST", body: {} }), /Refresh.*before trying again/i);
  assert.equal(writes, 1);
});

test("concurrent requests share discovery and remember the working bridge", async (t) => {
  let probes = 0;
  const base = await fixture(t, (req, res) => {
    if (req.url === "/health") { probes += 1; return json(res, 200, { ok: true, service: "soft-admin-api" }); }
    json(res, 200, { vods: [] });
  });
  const transport = createAdminTransport({ bases: [base] });
  assert.deepEqual(await Promise.all([transport.request("/vods"), transport.request("/vods")]), [{ vods: [] }, { vods: [] }]);
  await transport.request("/vods");
  assert.equal(probes, 1);
});

test("unrelated HTTP services are not accepted as the admin bridge", async (t) => {
  const base = await fixture(t, (_req, res) => json(res, 200, { ok: true, service: "unrelated" }));
  const transport = createAdminTransport({ bases: [base], discoveryTimeoutMs: 50 });
  await assert.rejects(transport.request("/vods"), /Open Softuchive/i);
});

test("a hung bridge request is aborted within its time limit", async (t) => {
  const base = await fixture(t, (req, res) => {
    if (req.url === "/health") json(res, 200, { ok: true, service: "soft-admin-api" });
  });
  const transport = createAdminTransport({ bases: [base], requestTimeoutMs: 30 });
  await assert.rejects(transport.request("/session"), /timed out/i);
});

test("an incomplete success body is not reported as a completed change", async (t) => {
  const base = await fixture(t, (req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true, service: "soft-admin-api" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"vod":');
  });
  const transport = createAdminTransport({ bases: [base] });
  await assert.rejects(transport.request("/vods/1/flags", { method: "POST", body: {} }), /may have completed/);
});
