import { Box } from "@mui/material";
import { useEffect, useRef } from "react";

const STAR_COUNT = 16;
const POINTER_DEFAULT = { x: 0.52, y: 0.44 };
const TARGET_FPS = 24;
const FRAME_MS = 1000 / TARGET_FPS;

const random = (min, max) => Math.random() * (max - min) + min;

const syncPointerCssVars = (pointerX, pointerY) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--soft-pointer-x", `${(pointerX * 100).toFixed(2)}%`);
  root.style.setProperty("--soft-pointer-y", `${(pointerY * 100).toFixed(2)}%`);
  root.style.setProperty("--soft-pointer-rx", ((pointerX - 0.5) * 2).toFixed(4));
  root.style.setProperty("--soft-pointer-ry", ((pointerY - 0.5) * 2).toFixed(4));
};

async function startTypeGpuBackdrop(gpuCanvasRef, sharedStateRef) {
  if (typeof window === "undefined" || !gpuCanvasRef.current) return () => {};
  if (!navigator.gpu) return () => {};
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return () => {};
  if (window.matchMedia?.("(max-width: 900px)")?.matches) return () => {};

  const canvas = gpuCanvasRef.current;
  const context = canvas.getContext("webgpu", { alpha: true });
  if (!context) return () => {};

  const [{ default: tgpu }, d] = await Promise.all([import("typegpu"), import("typegpu/data")]);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
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
    pointer: d.vec2f(POINTER_DEFAULT.x, POINTER_DEFAULT.y),
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

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn ring(p: vec2f, center: vec2f, radius: f32, width: f32) -> f32 {
  let d = abs(length(p - center) - radius);
  return exp(-pow(d / max(width, 0.001), 2.0) * 2.2);
}

@fragment
fn fsMain(inFrag: VertexOut) -> @location(0) vec4f {
  let res = max(u.resolution, vec2f(1.0, 1.0));
  let aspect = res.x / res.y;
  let t = u.time * 0.001;
  let uv = inFrag.uv;
  let centered = uv - 0.5;
  let p = vec2f(centered.x * aspect, centered.y);

  let mouse = vec2f((u.pointer.x - 0.5) * aspect, u.pointer.y - 0.5);
  let parallax = vec2f((u.pointer.x - 0.5) * 0.14, -(u.pointer.y - 0.5) * 0.10);

  let warpA = vec2f(
    sin((p.y + t * 0.25) * 5.4 + p.x * 1.8) * 0.045,
    cos((p.x - t * 0.20) * 6.2 - p.y * 1.2) * 0.035
  );
  let warpB = vec2f(
    cos((p.y - t * 0.42) * 7.4 + p.x * 0.9) * 0.035,
    sin((p.x + t * 0.31) * 5.9 + p.y * 1.4) * 0.028
  );
  let q = p + parallax + warpA + warpB;

  let ringA = ring(q, vec2f(-0.32 + sin(t * 0.45) * 0.12, -0.02 + cos(t * 0.52) * 0.07), 0.44, 0.055);
  let ringB = ring(q, vec2f(0.22 + cos(t * 0.37 + 0.6) * 0.10, 0.10 + sin(t * 0.33) * 0.08), 0.33, 0.045);
  let ringC = ring(q, vec2f(mouse.x * 0.65, mouse.y * 0.65), 0.22 + sin(t * 0.8) * 0.02, 0.032);

  let streak = pow(max(0.0, sin((q.x * 9.0 - q.y * 5.8) + t * 1.4) * 0.5 + 0.5), 4.0);
  let caustics = streak * (ringA * 0.8 + ringB * 0.75 + ringC * 1.2);
  let body = smoothstep(0.22, 0.95, ringA * 0.85 + ringB * 0.8 + ringC * 0.7);
  let cursorGlow = exp(-pow(length(q - mouse) * 3.8, 2.0) * 1.3);
  let vignette = 1.0 - smoothstep(0.35, 1.08, length(vec2f(centered.x * aspect, centered.y)));

  let tintMix = clamp(uv.x * 0.58 + uv.y * 0.20 + ringC * 0.2, 0.0, 1.0);
  let tint = mix(u.tintA.rgb, u.tintB.rgb, tintMix);
  var color =
    tint * (body * 0.15 + caustics * 0.18) +
    vec3f(1.0) * (caustics * 0.16 + cursorGlow * 0.08 + ringC * 0.06);

  let grain = (hash21(floor(uv * res * 0.5) + vec2f(t * 24.0, -t * 19.0)) - 0.5) / 255.0;
  color = (color + vec3f(grain)) * vignette;
  let alpha = clamp((body * 0.11 + caustics * 0.16 + cursorGlow * 0.04) * vignette * u.intensity, 0.0, 0.34);
  return vec4f(color, alpha);
}
`,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: window.GPUShaderStage?.FRAGMENT ?? 0x2, buffer: { type: "uniform" } }],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: "vsMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fsMain",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniforms.buffer } }],
  });

  let rafId = 0;
  let lastFrameMs = 0;

  const configureCanvas = () => {
    if (!canvas.isConnected) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, Math.min(1.25, window.devicePixelRatio || 1));
    const renderScale = 0.56;
    const nextWidth = Math.max(1, Math.floor(width * dpr * renderScale));
    const nextHeight = Math.max(1, Math.floor(height * dpr * renderScale));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    context.configure({ device, format, alphaMode: "premultiplied" });
  };

  configureCanvas();
  const resizeObserver = new ResizeObserver(configureCanvas);
  resizeObserver.observe(canvas);
  window.addEventListener("resize", configureCanvas);
  sharedStateRef.current.gpuActive = true;

    const render = (time) => {
      if (document.hidden) {
        rafId = window.requestAnimationFrame(render);
        return;
      }
    if (lastFrameMs && time - lastFrameMs < FRAME_MS) {
      rafId = window.requestAnimationFrame(render);
      return;
    }
    lastFrameMs = time;

    const pointerX = sharedStateRef.current.pointerX;
    const pointerY = sharedStateRef.current.pointerY;
    const isDark = document.documentElement.getAttribute("data-soft-theme") === "dark";

    uniforms.write({
      resolution: d.vec2f(canvas.width || 1, canvas.height || 1),
      pointer: d.vec2f(pointerX, pointerY),
      time: Number(time || 0),
      intensity: isDark ? 1.0 : 0.92,
      tintA: d.vec4f(0.831, 0.420, 0.549, 1.0),
      tintB: d.vec4f(isDark ? 0.39 : 0.475, isDark ? 0.53 : 0.639, isDark ? 0.86 : 0.902, 1.0),
    });

    let currentTexture;
    try {
      currentTexture = context.getCurrentTexture();
    } catch {
      configureCanvas();
      rafId = window.requestAnimationFrame(render);
      return;
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: currentTexture.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
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
    sharedStateRef.current.gpuActive = false;
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
    pointerX: POINTER_DEFAULT.x,
    pointerY: POINTER_DEFAULT.y,
    targetPointerX: POINTER_DEFAULT.x,
    targetPointerY: POINTER_DEFAULT.y,
    stars: [],
    rafId: 0,
    lastDrawMs: 0,
    gpuActive: false,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    const state = stateRef.current;

    const rebuildScene = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
      state.width = Math.max(1, Math.floor(rect.width));
      state.height = Math.max(1, Math.floor(rect.height));
      state.dpr = dpr;
      canvas.width = Math.floor(state.width * dpr);
      canvas.height = Math.floor(state.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      state.stars = Array.from({ length: STAR_COUNT }, () => ({
        x: random(0, state.width),
        y: random(0, state.height),
        r: random(0.6, 1.8),
        twinkle: random(0.35, 1.1),
        phase: random(0, Math.PI * 2),
        drift: random(-0.08, 0.08),
      }));
    };

    const draw = (time) => {
      const t = Number(time || 0);
      const { width, height, stars } = state;
      if (!width || !height) return;

      state.pointerX += (state.targetPointerX - state.pointerX) * 0.065;
      state.pointerY += (state.targetPointerY - state.pointerY) * 0.065;
      const pointerX = state.pointerX;
      const pointerY = state.pointerY;
      syncPointerCssVars(pointerX, pointerY);

      const isDark = document.documentElement.getAttribute("data-soft-theme") === "dark";
      ctx.clearRect(0, 0, width, height);

      const bgGradient = ctx.createLinearGradient(0, 0, width, height);
      if (isDark) {
        bgGradient.addColorStop(0, "rgba(13,18,31,0.98)");
        bgGradient.addColorStop(0.52, "rgba(14,22,40,0.94)");
        bgGradient.addColorStop(1, "rgba(17,24,39,0.98)");
      } else {
        bgGradient.addColorStop(0, "rgba(226,233,243,0.96)");
        bgGradient.addColorStop(0.56, "rgba(217,228,244,0.88)");
        bgGradient.addColorStop(1, "rgba(206,221,242,0.92)");
      }
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      const px = pointerX * width;
      const py = pointerY * height;

      // Ambient lens (autonomous motion; no cursor tracking for performance/cleanliness).
      ctx.save();
      const lens = ctx.createRadialGradient(px, py, 0, px, py, Math.max(width, height) * 0.16);
      lens.addColorStop(0, isDark ? "rgba(255,255,255,0.045)" : "rgba(255,255,255,0.12)");
      lens.addColorStop(0.42, isDark ? "rgba(121,163,230,0.045)" : "rgba(121,163,230,0.065)");
      lens.addColorStop(0.7, isDark ? "rgba(212,107,140,0.032)" : "rgba(212,107,140,0.048)");
      lens.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = lens;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = isDark ? "rgba(231,239,250,0.055)" : "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(34, Math.min(width, height) * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Keep the 2D layer lighter when GPU is active.
      if (!state.gpuActive) {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        for (let i = 0; i < 2; i += 1) {
          const y = height * (0.24 + i * 0.28) + Math.sin(t * (0.00025 + i * 0.00006) + i) * (14 + i * 5);
          const grad = ctx.createLinearGradient(0, y - 36, width, y + 36);
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(0.28, isDark ? "rgba(121,163,230,0.045)" : "rgba(121,163,230,0.06)");
          grad.addColorStop(0.52, isDark ? "rgba(212,107,140,0.038)" : "rgba(212,107,140,0.05)");
          grad.addColorStop(0.72, isDark ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)");
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(0, y - 40, width, 80);
        }
        ctx.restore();
      }

      // Stars stay subtle and cheap.
      ctx.save();
      for (const star of stars) {
        const alphaBase = isDark ? 0.035 : 0.08;
        const alphaDelta = isDark ? 0.08 : 0.12;
        const alpha = alphaBase + (Math.sin(t * 0.0012 * star.twinkle + star.phase) + 1) * alphaDelta * 0.5;
        const y = (star.y + t * 0.003 * star.drift + height) % height;
        const x = star.x + (pointerX - 0.5) * 1.2;
        ctx.beginPath();
        ctx.arc(x, y, star.r, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? `rgba(220,232,255,${alpha.toFixed(3)})` : `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.fill();
      }
      ctx.restore();
    };

    const loop = (time) => {
      if (document.hidden) {
        state.rafId = window.requestAnimationFrame(loop);
        return;
      }
      if (state.lastDrawMs && time - state.lastDrawMs < FRAME_MS) {
        state.rafId = window.requestAnimationFrame(loop);
        return;
      }
      state.lastDrawMs = time;
      // Autonomous focus point replaces cursor-follow to reduce lag/jitter.
      state.targetPointerX = 0.5 + Math.sin(time * 0.00019) * 0.11 + Math.cos(time * 0.00007) * 0.03;
      state.targetPointerY = 0.42 + Math.cos(time * 0.00017 + 0.6) * 0.09 + Math.sin(time * 0.00009) * 0.025;
      draw(time);
      state.rafId = window.requestAnimationFrame(loop);
    };

    rebuildScene();
    syncPointerCssVars(state.pointerX, state.pointerY);
    state.rafId = window.requestAnimationFrame(loop);
    window.addEventListener("resize", rebuildScene);

    return () => {
      window.cancelAnimationFrame(state.rafId);
      window.removeEventListener("resize", rebuildScene);
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
        console.error("TypeGPU backdrop failed, using 2D fallback only.", error);
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
      <Box className="liquid-backdrop__grain" />
    </Box>
  );
}
