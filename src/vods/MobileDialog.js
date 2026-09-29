import { useEffect, useState } from "react";
import { Dialog, useMediaQuery } from "@mui/material";

export default function MobileDialog({ sx, ...props }) {
  const isMobile = useMediaQuery("(max-width:1024px), (hover: none) and (pointer: coarse)");
  const [viewport, setViewport] = useState(null);

  useEffect(() => {
    if (!props.open || !isMobile) return;
    const visualViewport = window.visualViewport;
    let raf;
    let settleTimer;
    const measure = () => {
      const next = {
        width: Math.round(visualViewport?.width || window.innerWidth),
        height: Math.round(visualViewport?.height || window.innerHeight),
        top: Math.round(visualViewport?.offsetTop || 0),
        left: Math.round(visualViewport?.offsetLeft || 0),
      };
      setViewport(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
    };
    const queueMeasure = () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      raf = requestAnimationFrame(measure);
      settleTimer = setTimeout(measure, 220);
    };
    measure();
    window.addEventListener("resize", queueMeasure);
    window.addEventListener("orientationchange", queueMeasure);
    visualViewport?.addEventListener("resize", queueMeasure);
    visualViewport?.addEventListener("scroll", queueMeasure);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener("resize", queueMeasure);
      window.removeEventListener("orientationchange", queueMeasure);
      visualViewport?.removeEventListener("resize", queueMeasure);
      visualViewport?.removeEventListener("scroll", queueMeasure);
    };
  }, [props.open, isMobile]);

  return <Dialog {...props} sx={[
    ...(Array.isArray(sx) ? sx : [sx]),
    isMobile && {
      top: `${viewport?.top || 0}px`,
      left: `${viewport?.left || 0}px`,
      width: viewport?.width ? `${viewport.width}px` : "100vw",
      height: viewport?.height ? `${viewport.height}px` : "100dvh",
      right: "auto", bottom: "auto",
      "& .MuiDialog-container": { alignItems: "flex-start" },
      "& .MuiDialog-paper": {
        backgroundColor: (theme) => theme.palette.mode === "dark" ? "#151922" : "#fff9ee",
        mt: "max(env(safe-area-inset-top), 16px)",
        mb: "max(env(safe-area-inset-bottom), 16px)",
        maxHeight: "calc(100% - max(env(safe-area-inset-top), 16px) - max(env(safe-area-inset-bottom), 16px))",
      },
    },
  ]} />;
}
