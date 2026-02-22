import { Box } from "@mui/material";
import { useEffect, useRef } from "react";

const STAR_COUNT = 44;
const BLOB_COUNT = 5;
const DEFAULT_POINTER = { x: 0.5, y: 0.4 };

const random = (min, max) => Math.random() * (max - min) + min;

const syncPointerCssVars = (pointerX, pointerY) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const rx = (pointerX - 0.5) * 2;
  const ry = (pointerY - 0.5) * 2;
  root.style.setProperty("--soft-pointer-x", `${(pointerX * 100).toFixed(2)}%`);
  root.style.setProperty("--soft-pointer-y", `${(pointerY * 100).toFixed(2)}%`);
  root.style.setProperty("--soft-pointer-rx", rx.toFixed(4));
  root.style.setProperty("--soft-pointer-ry", ry.toFixed(4));
};

async function startTypeGpuBackdrop(gpuCanvasRef, sharedStateRef) {
  if (typeof window === "undefined" || !gpuCanvasRef.current) return () => {};
  if (!navigator.gpu) return () => {};
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return () => {};

  const canvas = gpuCanvasRef.current;
  const context = canvas.getContext("webgpu", { alpha: true });
  if (!context) return () => {};

  const [{ default: tgpu }, d] = await Promise.all([import("typegpu"), import("typegpu/data")]);

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) return () => {};

  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm";
  const root = tgpu.initFromDevice({ device });

  const Uniforms = d.struct({
    resolution: d.vec2f,
    pointer: d.vec2f,
    time: d.f32,
    intensity: d.f32,
    tintA: d.vec4f,
    tintB: d.vec4f,
  });

  const uniforms = root.createUniform(Uniforms, {
    resolution: d.vec2f(1, 1),
    pointer: d.vec2f(DEFAULT_POINTER.x, DEFAULT_POINTER.y),
    time: 0,
    intensity: 1,
    tintA: d.vec4f(0.831, 0.420, 0.549, 1.0),
    tintB: d.vec4f(0.475, 0.639, 0.902, 1.0),
  });

  const shaderModule = device.createShaderModule({
    code: `
struct Uniforms {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
  intensity: f32,
  tintA: vec4f,
  tintB: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0)
  );

  var out: VertexOut;
  let p = positions[index];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + 0.5;
  return out;
}

fn waveField(inputP: vec2f, time: f32) -> f32 {
  var p = inputP;
  var acc = 0.0;
  var amp = 0.55;
  var freq = 1.0;

  for (var i = 0; i < 4; i = i + 1) {
    let swirl = vec2f(
      sin(p.y * (2.8 * freq) + time * (0.9 + f32(i) * 0.2)),
      cos(p.x * (3.1 * freq) - time * (0.75 + f32(i) * 0.17))
    );
    p = p + swirl * 0.18;
    acc = acc + (sin((p.x + p.y) * (1.8 * freq) + time * (0.45 + f32(i) * 0.15)) * 0.5 + 0.5) * amp;
    amp = amp * 0.56;
    freq = freq * 1.74;
  }

  return acc;
}

@fragment
fn fsMain(inFrag: VertexOut) -> @location(0) vec4f {
  let res = max(u.resolution, vec2f(1.0, 1.0));
  let t = u.time * 0.001;
  let aspect = res.x / res.y;

  var uv = inFrag.uv;
  let centered = uv - 0.5;
  let mouse = vec2f((u.pointer.x - 0.5) * 2.0, (u.pointer.y - 0.5) * 2.0);

  var p = vec2f(centered.x * aspect, centered.y);
  p = p + vec2f(mouse.x * 0.22, -mouse.y * 0.18);

  let base = waveField(p * 2.8 + vec2f(t * 0.55, -t * 0.38), t);
  let ripple = waveField(p * 6.7 - vec2f(t * 0.90, t * 0.58), t * 1.35);

  let lens = smoothstep(0.96, 0.14, length(vec2f(centered.x * aspect, centered.y)));
  let edgeGlow = smoothstep(0.98, 0.36, length(vec2f(centered.x * aspect, centered.y)));
  let cursorHalo = smoothstep(0.65, 0.0, distance(uv, u.pointer));

  let streakX = pow(max(0.0, 1.0 - abs(centered.y + sin((centered.x + t * 0.6) * 10.0) * 0.05) * 6.0), 7.0);
  let streakY = pow(max(0.0, 1.0 - abs(centered.x + cos((centered.y - t * 0.4) * 11.0) * 0.04) * 7.0), 8.0) * 0.4;

  let liquid = clamp(0.15 + base * 0.55 + ripple * 0.24 + streakX * 0.32 + streakY, 0.0, 1.0);
  let tintMix = clamp(uv.y * 0.65 + uv.x * 0.35 + base * 0.12 - ripple * 0.07, 0.0, 1.0);
  let tint = mix(u.tintA.rgb, u.tintB.rgb, tintMix);

  let sparkle = vec3f(1.0) * (pow(max(0.0, base - 0.45), 3.5) * 0.35 + pow(max(0.0, ripple - 0.6), 4.0) * 0.25);
  let edgeTint = mix(u.tintA.rgb, u.tintB.rgb, 0.65) * edgeGlow * 0.18;
  let cursorTint = mix(u.tintB.rgb, vec3f(1.0), 0.25) * cursorHalo * 0.16;

  let color = tint * (0.12 + liquid * 0.34) + sparkle + edgeTint + cursorTint;
  let alpha = clamp((0.10 + liquid * 0.18 + edgeGlow * 0.14 + cursorHalo * 0.08) * u.intensity, 0.0, 0.62);
  return vec4f(color, alpha);
}
`,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: window.GPUShaderStage?.FRAGMENT ?? 0x2,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vsMain",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fsMain",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
    },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
  });

  let width = 1;
  let height = 1;
  let dpr = 1;
  let rafId = 0;

  const configureCanvas = () => {
    if (!canvas.isConnected) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const nextWidth = Math.max(1, Math.floor(width * dpr));
    const nextHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });
  };

  configureCanvas();
  const resizeObserver = new ResizeObserver(configureCanvas);
  resizeObserver.observe(canvas);
  window.addEventListener("resize", configureCanvas);

  const render = (time) => {
    const pointerX = sharedStateRef.current.pointerX;
    const pointerY = sharedStateRef.current.pointerY;
    const isDark = document.documentElement.getAttribute("data-soft-theme") === "dark";

    uniforms.write({
      resolution: d.vec2f(canvas.width || 1, canvas.height || 1),
      pointer: d.vec2f(pointerX, pointerY),
      time: Number(time || 0),
      intensity: isDark ? 1.1 : 0.95,
      tintA: d.vec4f(0.831, 0.420, 0.549, 1.0),
      tintB: d.vec4f(isDark ? 0.412 : 0.475, isDark ? 0.553 : 0.639, isDark ? 0.824 : 0.902, 1.0),
    });

    let currentTexture;
    try {
      currentTexture = context.getCurrentTexture();
    } catch (error) {
      configureCanvas();
      rafId = window.requestAnimationFrame(render);
      return;
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: currentTexture.createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);

    rafId = window.requestAnimationFrame(render);
  };

  rafId = window.requestAnimationFrame(render);

  return () => {
    window.cancelAnimationFrame(rafId);
    window.removeEventListener("resize", configureCanvas);
    resizeObserver.disconnect();
    try {
      root.destroy();
    } catch {
      // no-op
    }
  };
}

export default function LiquidBackdrop() {
  const canvasRef = useRef(null);
  const gpuCanvasRef = useRef(null);
  const stateRef = useRef({
    width: 0,
    height: 0,
    dpr: 1,
    pointerX: DEFAULT_POINTER.x,
    pointerY: DEFAULT_POINTER.y,
    targetPointerX: DEFAULT_POINTER.x,
    targetPointerY: DEFAULT_POINTER.y,
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
        r: random(0.7, 2.4),
        twinkle: random(0.3, 1.2),
        phase: random(0, Math.PI * 2),
        drift: random(-0.12, 0.12),
      }));

      state.blobs = Array.from({ length: BLOB_COUNT }, (_, index) => ({
        angle: random(0, Math.PI * 2),
        radiusFactor: 0.16 + index * 0.075,
        wobble: random(16, 60),
        speed: random(0.00013, 0.00036),
        size: random(180, 360),
        hueShift: index,
        phase: random(0, Math.PI * 2),
      }));
    };

    const draw = (time) => {
      const t = Number(time || 0);
      const { width, height, stars, blobs } = state;
      if (!width || !height) return;

      state.pointerX += (state.targetPointerX - state.pointerX) * 0.085;
      state.pointerY += (state.targetPointerY - state.pointerY) * 0.085;
      const pointerX = state.pointerX;
      const pointerY = state.pointerY;

      syncPointerCssVars(pointerX, pointerY);

      ctx.clearRect(0, 0, width, height);

      const bgGradient = ctx.createLinearGradient(0, 0, width, height);
      const isDark = document.documentElement.getAttribute("data-soft-theme") === "dark";
      if (isDark) {
        bgGradient.addColorStop(0, "rgba(13,18,31,0.98)");
        bgGradient.addColorStop(0.55, "rgba(15,23,42,0.92)");
        bgGradient.addColorStop(1, "rgba(17,24,39,0.96)");
      } else {
        bgGradient.addColorStop(0, "rgba(226,233,243,0.92)");
        bgGradient.addColorStop(0.45, "rgba(214,226,244,0.65)");
        bgGradient.addColorStop(1, "rgba(199,217,241,0.85)");
      }
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      const px = pointerX * width;
      const py = pointerY * height;
      const pointerGlow = ctx.createRadialGradient(px, py, 0, px, py, Math.max(width, height) * 0.32);
      pointerGlow.addColorStop(0, isDark ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.18)");
      pointerGlow.addColorStop(0.45, isDark ? "rgba(212,107,140,0.08)" : "rgba(212,107,140,0.10)");
      pointerGlow.addColorStop(1, "rgba(212,107,140,0)");
      ctx.fillStyle = pointerGlow;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      for (const star of stars) {
        const alphaBase = isDark ? 0.04 : 0.10;
        const alphaDelta = isDark ? 0.14 : 0.18;
        const alpha = alphaBase + (Math.sin(t * 0.0014 * star.twinkle + star.phase) + 1) * alphaDelta;
        const y = (star.y + t * 0.003 * star.drift + height) % height;
        const x = star.x + (pointerX - 0.5) * 8 * star.twinkle;
        ctx.beginPath();
        ctx.fillStyle = isDark ? `rgba(220,232,255,${alpha.toFixed(3)})` : `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.arc(x, y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const blob of blobs) {
        const orbitRadius = Math.min(width, height) * (0.22 + blob.radiusFactor);
        const cx =
          width * 0.5 +
          Math.cos(t * blob.speed + blob.angle) * orbitRadius +
          (pointerX - 0.5) * 180 +
          Math.sin(t * 0.00031 + blob.phase) * blob.wobble;
        const cy =
          height * 0.38 +
          Math.sin(t * blob.speed * 1.13 + blob.angle) * (orbitRadius * 0.55) +
          (pointerY - 0.45) * 145 +
          Math.cos(t * 0.00027 + blob.phase) * (blob.wobble * 0.8);
        const radius = blob.size + Math.sin(t * 0.0004 + blob.phase) * 42;

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        if (blob.hueShift % 2 === 0) {
          g.addColorStop(0, isDark ? "rgba(212,107,140,0.18)" : "rgba(212,107,140,0.26)");
          g.addColorStop(0.55, isDark ? "rgba(212,107,140,0.05)" : "rgba(212,107,140,0.08)");
          g.addColorStop(1, "rgba(212,107,140,0)");
        } else {
          g.addColorStop(0, isDark ? "rgba(117,163,230,0.18)" : "rgba(117,163,230,0.23)");
          g.addColorStop(0.55, isDark ? "rgba(117,163,230,0.06)" : "rgba(117,163,230,0.07)");
          g.addColorStop(1, "rgba(117,163,230,0)");
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = isDark ? "rgba(167,187,219,0.08)" : "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i += 1) {
        const y = height * (0.08 + i * 0.11) + Math.sin(t * 0.00035 + i) * 10 + (pointerY - 0.5) * (4 + i * 1.4);
        ctx.beginPath();
        ctx.moveTo(-20, y);
        for (let x = 0; x <= width + 40; x += 80) {
          const wave = Math.sin(t * 0.0006 + x * 0.01 + i * 0.8 + (pointerX - 0.5) * 1.5) * 10;
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
      state.targetPointerX = (event.clientX - rect.left) / rect.width;
      state.targetPointerY = (event.clientY - rect.top) / rect.height;
    };

    const resetPointer = () => {
      state.targetPointerX = DEFAULT_POINTER.x;
      state.targetPointerY = DEFAULT_POINTER.y;
    };

    rebuildScene();
    syncPointerCssVars(state.pointerX, state.pointerY);
    state.rafId = window.requestAnimationFrame(loop);
    window.addEventListener("resize", rebuildScene);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", resetPointer);

    return () => {
      window.cancelAnimationFrame(state.rafId);
      window.removeEventListener("resize", rebuildScene);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", resetPointer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    startTypeGpuBackdrop(gpuCanvasRef, stateRef)
      .then((teardown) => {
        if (disposed) {
          teardown?.();
          return;
        }
        cleanup = teardown || (() => {});
      })
      .catch((error) => {
        console.error("TypeGPU backdrop failed, falling back to 2D backdrop only.", error);
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return (
    <Box className="liquid-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="liquid-backdrop__canvas" />
      <canvas ref={gpuCanvasRef} className="liquid-backdrop__gpu" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--a" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--b" />
      <Box className="liquid-backdrop__cloud liquid-backdrop__cloud--c" />
      <Box className="liquid-backdrop__orbit liquid-backdrop__orbit--a" />
      <Box className="liquid-backdrop__orbit liquid-backdrop__orbit--b" />
      <Box className="liquid-backdrop__wordmark">softu</Box>
    </Box>
  );
}
