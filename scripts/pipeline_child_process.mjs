import { spawn } from "node:child_process";

const stopChildTree = (child, force) => {
  const stopDirectly = () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} };
  if (process.platform === "win32") {
    if (!child.pid) return;
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true, stdio: "ignore",
    });
    killer.on("error", stopDirectly);
    killer.on("exit", (code) => { if (code) stopDirectly(); });
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { stopDirectly(); }
  }
};

// Resolve only after close: the run lock must outlive the child and its output handles.
export const runPipelineChild = (command, args, {
  label = "Archive command", timeoutMs = 15 * 60_000, shouldPause,
  pollIntervalMs = 1000, killGraceMs = 5000, signal,
  captureOutput = false, maxOutputBytes = 64 * 1024,
  spawnImpl = spawn, stopChild = stopChildTree,
} = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  let child;
  try {
    child = spawnImpl(command, args, { windowsHide: true, stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit", detached: process.platform !== "win32" });
  } catch (error) { reject(error); return; }
  let failure = null;
  let settled = false;
  let checkingPause = false;
  let escalationTimer;
  let outputBytes = 0;
  const output = { stdout: "", stderr: "" };
  const stop = (error) => {
    if (settled || failure) return;
    failure = error;
    try { stopChild(child, false); } catch {}
    escalationTimer = setTimeout(() => {
      if (!settled) { try { stopChild(child, true); } catch {} }
    }, killGraceMs);
  };
  const onAbort = () => stop(signal.reason || new Error(`${label} aborted.`));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => stop(Object.assign(new Error(`${label} timed out.`), { code: "ETIMEDOUT" })), timeoutMs);
  const poll = shouldPause ? setInterval(async () => {
    if (checkingPause || failure || settled) return;
    checkingPause = true;
    try {
      if (await shouldPause()) stop(Object.assign(new Error(`${label} paused.`), { code: "SOFTUCHIVE_PAUSED" }));
    } catch (error) { stop(error); }
    finally { checkingPause = false; }
  }, pollIntervalMs) : null;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearInterval(poll);
    clearTimeout(escalationTimer);
    signal?.removeEventListener("abort", onAbort);
    if (error) reject(error);
    else resolve(output);
  };
  if (captureOutput) {
    for (const stream of ["stdout", "stderr"]) child[stream]?.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop(new Error(`${label} produced too much output.`));
        return;
      }
      output[stream] += chunk.toString("utf8");
    });
  }
  child.once("error", (error) => { failure ||= error; if (!child.pid) finish(failure); });
  child.once("close", (code, childSignal) => finish(failure || (code === 0 ? null : new Error(`${label} failed (${childSignal || `exit ${code}`}).`))));
  if (signal?.aborted) onAbort();
});
