import { useEffect, useRef } from "react";

const POINTER_DEFAULT = { x: 0.45, y: 0.5 };
const FPS_ACTIVE = 18;
const FPS_IDLE = 8;
const FRAME_MS_ACTIVE = 1000 / FPS_ACTIVE;
const FRAME_MS_IDLE = 1000 / FPS_IDLE;
const RENDER_SCALE = 0.76;
const DEFERRED_START_TIMEOUT_MS = 1800;

async function startButtonGpu(canvas, tone) {
  if (!canvas || typeof window === "undefined") return () => {};
  if (!navigator.gpu) return () => {};
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return () => {};
  if (window.matchMedia?.("(max-width: 900px)")?.matches) return () => {};
  if (navigator.connection?.saveData) return () => {};

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
    hover: d.f32,
    accentA: d.vec4f,
    accentB: d.vec4f,
  });

  const palette =
    tone === "blue"
      ? {
          accentA: d.vec4f(0.35, 0.55, 0.95, 1),
          accentB: d.vec4f(0.78, 0.90, 1.0, 1),
        }
      : {
          accentA: d.vec4f(0.83, 0.42, 0.55, 1),
          accentB: d.vec4f(1.0, 0.86, 0.92, 1),
        };

  const uniforms = root.createUniform(Uniforms, {
    resolution: d.vec2f(1, 1),
    pointer: d.vec2f(POINTER_DEFAULT.x, POINTER_DEFAULT.y),
    time: 0,
    hover: 0.2,
    accentA: palette.accentA,
    accentB: palette.accentB,
  });

  const shader = device.createShaderModule({
    code: `
struct Uniforms {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
  hover: f32,
  accentA: vec4f,
  accentB: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  var tri = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0)
  );
  var out: VertexOut;
  let p = tri[i];
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + 0.5;
  return out;
}

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@fragment
fn fs(inFrag: VertexOut) -> @location(0) vec4f {
  let uv = inFrag.uv;
  let res = max(u.resolution, vec2f(1.0, 1.0));
  let aspect = res.x / res.y;
  let t = u.time * 0.001;
  let p = vec2f((uv.x - 0.5) * aspect, uv.y - 0.5);
  let m = vec2f((u.pointer.x - 0.5) * aspect, u.pointer.y - 0.5);

  let d = distance(p, m);
  let cursorRing = exp(-pow(d * 7.0 - 0.85, 2.0) * 6.0);
  let cursorCore = exp(-pow(d * 5.8, 2.0) * 3.2);

  let sweep = sin((p.x * 10.0 - p.y * 6.0) + t * 1.8 + m.x * 5.0);
  let caustic = pow(max(0.0, sweep * 0.5 + 0.5), 3.0) * (0.25 + cursorRing * 1.2);

  let ribbon = exp(-pow(p.y * 4.2 + sin((p.x + t * 0.45) * 5.5) * 0.65, 2.0) * 3.0);
  let gloss = exp(-pow((uv.y - 0.1) * 12.0, 2.0)) * 0.6;

  let tintMix = clamp(uv.x * 0.55 + uv.y * 0.2 + cursorRing * 0.2, 0.0, 1.0);
  let tint = mix(u.accentA.rgb, u.accentB.rgb, tintMix);

  let grain = (hash21(floor(uv * res * 0.5) + vec2f(t * 25.0, -t * 21.0)) - 0.5) / 255.0;
  let alpha = clamp((ribbon * 0.16 + caustic * 0.12 + cursorCore * 0.12 + gloss * 0.14) * (0.3 + u.hover * 0.9), 0.0, 0.42);
  let color = tint * (ribbon * 0.18 + caustic * 0.14) + vec3f(1.0) * (gloss * 0.14 + cursorCore * 0.18 + cursorRing * 0.08);
  color = color + grain;

  return vec4f(color, alpha);
}
`,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: window.GPUShaderStage?.FRAGMENT ?? 0x2, buffer: { type: "uniform" } }],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader, entryPoint: "vs" },
    fragment: {
      module: shader,
      entryPoint: "fs",
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

  const state = {
    pointerX: POINTER_DEFAULT.x,
    pointerY: POINTER_DEFAULT.y,
    targetX: POINTER_DEFAULT.x,
    targetY: POINTER_DEFAULT.y,
    hover: 0,
    targetHover: 0,
    visible: true,
    rafId: 0,
    lastFrameMs: 0,
  };

  const host = canvas.parentElement;
  if (!host) return () => {};

  const configure = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(1.25, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.floor(rect.width * dpr * RENDER_SCALE));
    const height = Math.max(1, Math.floor(rect.height * dpr * RENDER_SCALE));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.configure({ device, format, alphaMode: "premultiplied" });
  };

  const onMove = (event) => {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.targetX = (event.clientX - rect.left) / rect.width;
    state.targetY = (event.clientY - rect.top) / rect.height;
    state.targetHover = 1;
  };
  const onEnter = () => {
    state.targetHover = 1;
  };
  const onLeave = () => {
    state.targetHover = 0.18;
    state.targetX = POINTER_DEFAULT.x;
    state.targetY = POINTER_DEFAULT.y;
  };
  const visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      state.visible = Boolean(entry?.isIntersecting);
      if (!state.visible) {
        state.targetHover = 0.12;
      }
    },
    { threshold: 0.01 }
  );

  configure();
  const resizeObserver = new ResizeObserver(configure);
  resizeObserver.observe(canvas);
  visibilityObserver.observe(host);
  host.addEventListener("pointermove", onMove, { passive: true });
  host.addEventListener("pointerenter", onEnter);
  host.addEventListener("pointerleave", onLeave);

  const render = (time) => {
    if (document.hidden || !state.visible) {
      state.rafId = window.requestAnimationFrame(render);
      return;
    }
    const frameBudget = state.targetHover > 0.3 ? FRAME_MS_ACTIVE : FRAME_MS_IDLE;
    if (state.lastFrameMs && time - state.lastFrameMs < frameBudget) {
      state.rafId = window.requestAnimationFrame(render);
      return;
    }
    state.lastFrameMs = time;

    state.pointerX += (state.targetX - state.pointerX) * 0.12;
    state.pointerY += (state.targetY - state.pointerY) * 0.12;
    state.hover += (state.targetHover - state.hover) * 0.12;

    uniforms.write({
      resolution: d.vec2f(canvas.width || 1, canvas.height || 1),
      pointer: d.vec2f(state.pointerX, state.pointerY),
      time: Number(time || 0),
      hover: state.hover,
      accentA: palette.accentA,
      accentB: palette.accentB,
    });

    let texture;
    try {
      texture = context.getCurrentTexture();
    } catch {
      configure();
      state.rafId = window.requestAnimationFrame(render);
      return;
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);

    state.rafId = window.requestAnimationFrame(render);
  };

  state.rafId = window.requestAnimationFrame(render);

  return () => {
    window.cancelAnimationFrame(state.rafId);
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerenter", onEnter);
    host.removeEventListener("pointerleave", onLeave);
    try {
      root.destroy();
    } catch {
      // no-op
    }
  };
}

export default function TypeGpuButtonOverlay({ tone = "salmon" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host || typeof window === "undefined") return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return undefined;
    if (navigator.connection?.saveData) return undefined;

    let disposed = false;
    let started = false;
    let teardown = () => {};
    let visibilityObserver = null;
    let idleId = null;
    let timeoutId = null;
    let isVisible = false;

    const clearPendingStart = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idleId);
        } catch {
          // no-op
        }
        idleId = null;
      }
    };

    const start = () => {
      if (started || disposed) return;
      started = true;
      clearPendingStart();

      startButtonGpu(canvas, tone)
        .then((cleanup) => {
          if (disposed) {
            cleanup?.();
            return;
          }
          teardown = cleanup || (() => {});
        })
        .catch((error) => {
          console.error("TypeGPU button overlay failed.", error);
        });
    };

    const scheduleStart = () => {
      if (started || disposed || !isVisible) return;
      clearPendingStart();

      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(
          () => {
            timeoutId = window.setTimeout(start, 120);
          },
          { timeout: DEFERRED_START_TIMEOUT_MS + 900 }
        );
        return;
      }

      timeoutId = window.setTimeout(start, DEFERRED_START_TIMEOUT_MS);
    };

    const handlePointerEnter = () => {
      isVisible = true;
      start();
    };

    host.addEventListener("pointerenter", handlePointerEnter, { passive: true });

    if (typeof window.IntersectionObserver === "function") {
      visibilityObserver = new window.IntersectionObserver(
        ([entry]) => {
          isVisible = Boolean(entry?.isIntersecting);
          if (isVisible) {
            scheduleStart();
            return;
          }
          clearPendingStart();
        },
        {
          threshold: 0.15,
          rootMargin: "120px 0px",
        }
      );
      visibilityObserver.observe(host);
    } else {
      isVisible = true;
      scheduleStart();
    }

    return () => {
      disposed = true;
      clearPendingStart();
      host.removeEventListener("pointerenter", handlePointerEnter);
      visibilityObserver?.disconnect();
      teardown();
    };
  }, [tone]);

  return <canvas ref={canvasRef} className="soft-cta-button__gpu" aria-hidden="true" />;
}
