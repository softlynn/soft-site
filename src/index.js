import React from "react";
import { createRoot } from "react-dom/client";
import "./css/index.css";
import App from "./App";
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
root.render(<App />);
