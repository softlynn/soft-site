import { Box } from "@mui/material";
import { useEffect, useRef, useState } from "react";

const observerPool = new Map();
const REVEAL_ROOT_MARGIN = "0px 0px -8% 0px";

const getObserverKey = (threshold) => JSON.stringify(threshold);

const getObserverEntry = (threshold) => {
  const key = getObserverKey(threshold);
  const existing = observerPool.get(key);
  if (existing) return existing;

  const listeners = new WeakMap();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        listeners.get(entry.target)?.(entry);
      }
    },
    { threshold, rootMargin: REVEAL_ROOT_MARGIN }
  );

  const nextEntry = { key, observer, listeners, size: 0 };
  observerPool.set(key, nextEntry);
  return nextEntry;
};

const observeRevealNode = (node, threshold, listener) => {
  const entry = getObserverEntry(threshold);
  entry.listeners.set(node, listener);
  entry.size += 1;
  entry.observer.observe(node);

  return () => {
    entry.observer.unobserve(node);
    entry.listeners.delete(node);
    entry.size -= 1;
    if (entry.size <= 0) {
      entry.observer.disconnect();
      observerPool.delete(entry.key);
    }
  };
};

const isInitiallyVisible = (node) => {
  if (!node || typeof window === "undefined") return false;
  const rect = node.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= viewportHeight * 0.96 && rect.left <= viewportWidth;
};

export default function Reveal(props) {
  const { children, delay = 0, threshold = 0.2, once = true, className = "", sx, ...rest } = props;
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    if (isInitiallyVisible(node)) {
      setVisible(true);
      return undefined;
    }

    let stopObserving = () => {};
    stopObserving = observeRevealNode(node, threshold, (entry) => {
      if (entry.isIntersecting) {
        setVisible((current) => (current ? current : true));
        if (once) stopObserving();
        return;
      }
      if (!once) {
        setVisible(false);
      }
    });

    return () => {
      stopObserving();
    };
  }, [once, threshold]);

  return (
    <Box
      ref={ref}
      className={`soft-reveal ${visible ? "is-visible" : ""} ${className}`.trim()}
      sx={{
        "--soft-reveal-delay": `${delay}ms`,
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Box>
  );
}
