import { Box } from "@mui/material";
import { useEffect, useRef } from "react";

const STAR_COUNT = 40;
const BLOB_COUNT = 4;

const random = (min, max) => Math.random() * (max - min) + min;

export default function LiquidBackdrop() {
  const canvasRef = useRef(null);
  const stateRef = useRef({
    width: 0,
    height: 0,
    dpr: 1,
    pointerX: 0.5,
    pointerY: 0.4,
    stars: [],
    blobs: [],
    rafId: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    const state = stateRef.current;

    const rebuildScene = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      state.width = Math.max(1, Math.floor(rect.width));
      state.height = Math.max(1, Math.floor(rect.height));
      state.dpr = dpr;
      canvas.width = Math.floor(state.width * dpr);
      canvas.height = Math.floor(state.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      state.stars = Array.from({ length: STAR_COUNT }, () => ({
        x: random(0, state.width),
        y: random(0, state.height),
        r: random(0.7, 2.3),
        twinkle: random(0.3, 1.2),
        phase: random(0, Math.PI * 2),
        drift: random(-0.12, 0.12),
      }));

      state.blobs = Array.from({ length: BLOB_COUNT }, (_, index) => ({
        angle: random(0, Math.PI * 2),
        radiusFactor: 0.2 + index * 0.08,
        wobble: random(16, 54),
        speed: random(0.00012, 0.00034),
        size: random(180, 340),
        hueShift: index,
        phase: random(0, Math.PI * 2),
      }));
    };

    const draw = (time) => {
      const t = Number(time || 0);
      const { width, height, pointerX, pointerY, stars, blobs } = state;
      if (!width || !height) return;

      ctx.clearRect(0, 0, width, height);

      const bgGradient = ctx.createLinearGradient(0, 0, width, height);
      bgGradient.addColorStop(0, "rgba(226,233,243,0.92)");
      bgGradient.addColorStop(0.45, "rgba(214,226,244,0.65)");
      bgGradient.addColorStop(1, "rgba(199,217,241,0.85)");
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      for (const star of stars) {
        const alpha = 0.12 + (Math.sin(t * 0.0014 * star.twinkle + star.phase) + 1) * 0.18;
        const y = (star.y + t * 0.003 * star.drift + height) % height;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.arc(star.x, y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const blob of blobs) {
        const orbitRadius = Math.min(width, height) * (0.24 + blob.radiusFactor);
        const cx =
          width * 0.5 +
          Math.cos(t * blob.speed + blob.angle) * orbitRadius +
          (pointerX - 0.5) * 120 +
          Math.sin(t * 0.00031 + blob.phase) * blob.wobble;
        const cy =
          height * 0.38 +
          Math.sin(t * blob.speed * 1.13 + blob.angle) * (orbitRadius * 0.55) +
          (pointerY - 0.45) * 90 +
          Math.cos(t * 0.00027 + blob.phase) * (blob.wobble * 0.8);
        const radius = blob.size + Math.sin(t * 0.0004 + blob.phase) * 36;

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        if (blob.hueShift % 2 === 0) {
          g.addColorStop(0, "rgba(212,107,140,0.26)");
          g.addColorStop(0.55, "rgba(212,107,140,0.08)");
          g.addColorStop(1, "rgba(212,107,140,0)");
        } else {
          g.addColorStop(0, "rgba(117,163,230,0.23)");
          g.addColorStop(0.55, "rgba(117,163,230,0.07)");
          g.addColorStop(1, "rgba(117,163,230,0)");
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i += 1) {
        const y = height * (0.08 + i * 0.11) + Math.sin(t * 0.00035 + i) * 10;
        ctx.beginPath();
        ctx.moveTo(-20, y);
        for (let x = 0; x <= width + 40; x += 80) {
          const wave = Math.sin(t * 0.0006 + x * 0.01 + i * 0.8) * 10;
          ctx.quadraticCurveTo(x + 40, y + wave, x + 80, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    const loop = (time) => {
      draw(time);
      state.rafId = window.requestAnimationFrame(loop);
    };

    const onPointerMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      state.pointerX = (event.clientX - rect.left) / rect.width;
      state.pointerY = (event.clientY - rect.top) / rect.height;
    };

    rebuildScene();
    state.rafId = window.requestAnimationFrame(loop);
    window.addEventListener("resize", rebuildScene);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(state.rafId);
      window.removeEventListener("resize", rebuildScene);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  return (
    <Box className="liquid-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="liquid-backdrop__canvas" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--a" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--b" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--c" />
      <Box className="liquid-backdrop__orbit liquid-backdrop__orbit--a" />
      <Box className="liquid-backdrop__orbit liquid-backdrop__orbit--b" />
      <Box className="liquid-backdrop__wordmark">softu</Box>
    </Box>
  );
}
