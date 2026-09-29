import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const html = await fs.readFile(new URL("../public/404.html", import.meta.url), "utf8");
const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(script, "Pages fallback must contain its redirect script");
const appSource = await fs.readFile(new URL("../src/App.js", import.meta.url), "utf8");
const handler = appSource.match(/function SpaRedirectHandler\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(handler, "App must contain its Pages handoff consumer");

const runRedirect = (href, storageFailure = "", stalePath = "") => {
  const original = new URL(href);
  const saved = new Map();
  if (stalePath) saved.set("softu-spa-redirect", stalePath);
  const replacements = [];
  const browser = {
    location: {
      origin: original.origin, pathname: original.pathname, search: original.search, hash: original.hash,
      replace: (target) => replacements.push(target),
    },
  };
  Object.defineProperty(browser, "sessionStorage", {
    get() {
      if (storageFailure === "access") throw new Error("SecurityError: storage is blocked");
      return {
        setItem(key, value) {
          if (storageFailure === "write") throw new Error("QuotaExceededError: storage is unavailable");
          saved.set(key, value);
        },
      };
    },
  });
  browser.window = browser;
  vm.runInNewContext(script, browser, { timeout: 1000 });
  assert.equal(replacements.length, 1, "Pages handoff must navigate exactly once");
  return { saved, destination: replacements[0], storageFailure };
};

const createAppRouteHarness = ({ destination, saved, storageFailure }) => {
  const navigations = [];
  const browser = { location: new URL(destination) };
  const refs = [];
  const effects = [];
  let refIndex = 0;
  Object.defineProperty(browser, "sessionStorage", {
    get() {
      if (storageFailure === "access") throw new Error("SecurityError: storage is blocked");
      return { getItem: (key) => saved.get(key) || null, removeItem: (key) => saved.delete(key) };
    },
  });
  const context = vm.createContext({
    window: browser, URL, useEffect: (effect) => effects.push(effect),
    useRef: (value) => refs[refIndex++] ||= { current: value },
    useNavigate: () => (target, options) => {
      navigations.push({ target, replace: options.replace });
      browser.location = new URL(target, browser.location.origin);
    },
  });
  vm.runInContext(handler, context, { timeout: 1000 });
  const replayEffects = () => { for (const effect of effects) effect(); };
  return {
    navigations, browser, replayEffects,
    render() {
      refIndex = 0;
      effects.length = 0;
      vm.runInContext("SpaRedirectHandler();", context, { timeout: 1000 });
      replayEffects();
    },
  };
};

const restoreAppRoute = (result) => {
  const harness = createAppRouteHarness(result);
  harness.render();
  const { navigations } = harness;
  assert.equal(navigations.length, 1, "App must consume the Pages handoff exactly once");
  assert.equal(navigations[0].replace, true);
  return navigations[0].target;
};

test("Pages deep links retain the normal storage handoff with path, query and hash intact", () => {
  const result = runRedirect("https://softu.one/2838217827?p=2&t=1m30s#chapter-2");
  const { saved, destination } = result;
  assert.equal(saved.get("softu-spa-redirect"), "/2838217827?p=2&t=1m30s#chapter-2");
  assert.equal(destination, "https://softu.one/");
  assert.equal(restoreAppRoute(result), "/2838217827?p=2&t=1m30s#chapter-2");
  assert.equal(saved.size, 0);
});

for (const storageFailure of ["access", "write"]) {
  test(`Pages deep links use the supported hash handoff when storage ${storageFailure} fails`, () => {
    const result = runRedirect("https://softu.one/archive%20night?p=2&t=1m30s&label=a%2Fb%20c#chapter%202", storageFailure);
    const { saved, destination } = result;
    assert.equal(saved.size, 0);
    assert.equal(destination, "https://softu.one/#/archive%20night?p=2&t=1m30s&label=a%2Fb%20c#chapter%202");
    const handoff = new URL(destination);
    const restored = new URL(handoff.hash.slice(1), handoff.origin);
    assert.equal(restored.pathname, "/archive%20night");
    assert.equal(restored.search, "?p=2&t=1m30s&label=a%2Fb%20c");
    assert.equal(restored.hash, "#chapter%202");
    assert.equal(restoreAppRoute(result), "/archive%20night?p=2&t=1m30s&label=a%2Fb%20c#chapter%202");
  });
}

test("a blocked-storage handoff without query or hash still reaches the root document", () => {
  const { destination } = runRedirect("https://softu.one/2838217827", "write");
  assert.equal(destination, "https://softu.one/#/2838217827");
  assert.equal(new URL(destination).pathname, "/");
});

test("a failed storage write cannot let an older stored handoff replace the requested route", () => {
  const result = runRedirect("https://softu.one/2838217827?p=2&t=1m30s#chapter-2", "write", "/stale-vod?t=0");
  assert.equal(restoreAppRoute(result), "/2838217827?p=2&t=1m30s#chapter-2");
  assert.equal(result.saved.size, 0);
});

for (const storageFailure of ["", "access", "write"]) {
  test(`the ${storageFailure || "normal storage"} handoff is consumed once across router rerenders and effect replay`, () => {
    const target = "/2838217827?t=1m30s#/chapter-2";
    const harness = createAppRouteHarness(runRedirect(`https://softu.one${target}`, storageFailure));
    harness.render();
    assert.deepEqual(harness.navigations, [{ target, replace: true }]);
    harness.replayEffects();
    // BrowserRouter changes useNavigate's identity when the pathname changes.
    // Preserve hook refs while running the actual effect with that new callback.
    harness.render();
    harness.render();
    assert.deepEqual(harness.navigations, [{ target, replace: true }]);
    assert.equal(harness.browser.location.href, `https://softu.one${target}`);
  });
}
