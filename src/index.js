import React from "react";
import { createRoot } from "react-dom/client";
import "./css/index.css";
import App from "./App";
import ErrorBoundary from "./utils/ErrorBoundary";
import "simplebar-react/dist/simplebar.min.css";

const IGNORED_RESIZE_OBSERVER_ERRORS = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

window.addEventListener(
  "error",
  (event) => {
    if (IGNORED_RESIZE_OBSERVER_ERRORS.has(event.message)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  },
  true
);

window.addEventListener("unhandledrejection", (event) => {
  const message = String(event.reason?.message || event.reason || "");
  if (IGNORED_RESIZE_OBSERVER_ERRORS.has(message)) {
    event.preventDefault();
  }
});

const container = document.getElementById("root");
const root = createRoot(container);
root.render(
  <ErrorBoundary fallback={
    <main style={{ minHeight: "100vh", display: "grid", placeContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
      <h1 style={{ fontSize: 24, margin: 0 }}>Let’s try that again</h1>
      <p style={{ margin: 0 }}>The page couldn’t load. Your archive is still here.</p>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: "10px 20px", cursor: "pointer", font: "inherit" }}>Reload page</button>
    </main>
  }><App /></ErrorBoundary>
);
