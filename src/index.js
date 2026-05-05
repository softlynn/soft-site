import React from "react";
import { createRoot } from "react-dom/client";
import "./css/index.css";
import App from "./App";
import reportWebVitals from "./reportWebVitals";
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

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
