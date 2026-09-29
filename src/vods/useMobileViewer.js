import { useEffect, useState } from "react";

// Use a viewport-sized overlay instead of the element fullscreen API, which
// is not consistently available for a video-and-chat layout on iOS Safari.
export default function useMobileViewer({ isMobile, isPortrait }) {
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0, landscape: null });
  const mobileViewerFullscreen = isMobile && expanded;
  const mobileFullscreenSideLayout = mobileViewerFullscreen && (viewport.landscape ?? !isPortrait);
  const useStackedMobileLayout = mobileViewerFullscreen ? !mobileFullscreenSideLayout : isPortrait;

  useEffect(() => {
    if (!isMobile) setExpanded(false);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileViewerFullscreen) return;
    const html = document.documentElement;
    const body = document.body;
    const previous = { htmlOverflow: html.style.overflow, position: body.style.position, top: body.style.top, width: body.style.width };
    const scrollY = window.scrollY;
    html.style.overflow = "hidden";
    // Leave inline body overflow to MUI's dialogs/menus. Their cleanup may run
    // after this hook on navigation; a shared snapshot would retain a stale lock.
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    let raf;
    let settleTimer;
    const measure = () => {
      const width = Math.round(window.visualViewport?.width || window.innerWidth || 0);
      const height = Math.round(window.visualViewport?.height || window.innerHeight || 0);
      const active = document.activeElement;
      const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName) || active?.isContentEditable;
      setViewport((previous) => {
        // The keyboard changes visible height; a width change also needs the
        // layout viewport orientation so physical rotation still works while typing.
        const landscape = editing && previous.landscape !== null
          ? previous.width === width ? previous.landscape : (window.innerWidth || width) > (window.innerHeight || height)
          : width > height;
        return previous.width === width && previous.height === height && previous.landscape === landscape
          ? previous : { width, height, landscape };
      });
    };
    const queueMeasure = () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      raf = requestAnimationFrame(measure);
      settleTimer = setTimeout(measure, 220);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.fullscreenElement || document.webkitFullscreenElement) return;
      const activeOverlay = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')).some((overlay) => {
        // VideoJS retains hidden dialogs and exposes an uncloseable error
        // message as a dialog; neither owns Escape ahead of the viewer.
        if (overlay.matches(".vjs-error-display") || overlay.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const visibility = window.getComputedStyle(overlay).visibility;
        return overlay.getClientRects().length > 0 && visibility !== "hidden" && visibility !== "collapse";
      });
      if (!activeOverlay) setExpanded(false);
    };
    measure();
    window.addEventListener("resize", queueMeasure);
    window.addEventListener("orientationchange", queueMeasure);
    // Player controls stop keydown bubbling, so observe Escape in capture.
    window.addEventListener("keydown", onKeyDown, true);
    window.visualViewport?.addEventListener("resize", queueMeasure);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener("resize", queueMeasure);
      window.removeEventListener("orientationchange", queueMeasure);
      window.removeEventListener("keydown", onKeyDown, true);
      window.visualViewport?.removeEventListener("resize", queueMeasure);
      html.style.overflow = previous.htmlOverflow;
      Object.assign(body.style, { position: previous.position, top: previous.top, width: previous.width });
      window.scrollTo(0, scrollY);
    };
  }, [mobileViewerFullscreen]);

  return {
    mobileViewerFullscreen,
    mobileFullscreenSideLayout,
    useStackedMobileLayout,
    fullscreenViewportHeight: mobileViewerFullscreen ? viewport.height ? `${viewport.height}px` : "100dvh" : "100%",
    fullscreenViewportWidth: mobileViewerFullscreen ? viewport.width ? `${viewport.width}px` : "100vw" : "100%",
    toggleFullscreen: () => { if (isMobile) setExpanded((previous) => !previous); },
  };
}
