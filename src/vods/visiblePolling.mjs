// One request at a time, with no timers or retry budget spent in a hidden tab.
export const startVisiblePolling = ({
  poll,
  onResult,
  onError,
  onFinish,
  intervalMs,
  maxAttempts = Infinity,
}, host = globalThis) => {
  const visibility = host.document;
  let stopped = false;
  let timer = null;
  let request = null;
  let attempts = 0;
  const isVisible = () => !visibility?.hidden;
  const clearTimer = () => {
    if (timer !== null) host.clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    request?.abort();
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
    onFinish?.();
  };

  const run = async () => {
    if (stopped || request || !isVisible()) return;
    clearTimer();
    const controller = new AbortController();
    request = controller;
    try {
      const value = await poll({ signal: controller.signal });
      if (stopped || controller.signal.aborted || !isVisible()) return;
      attempts += 1;
      if (onResult?.(value) === true) stop();
    } catch (error) {
      if (stopped || controller.signal.aborted || !isVisible()) return;
      attempts += 1;
      onError?.(error);
    } finally {
      request = null;
      if (!stopped && attempts >= maxAttempts) stop();
      if (!stopped && isVisible()) {
        // A rapid hide/show still waits for the canceled request to settle.
        if (controller.signal.aborted) void run();
        else timer = host.setTimeout(() => { timer = null; void run(); }, intervalMs);
      }
    }
  };

  function onVisibilityChange() {
    clearTimer();
    if (!isVisible()) request?.abort();
    else void run();
  }

  visibility?.addEventListener("visibilitychange", onVisibilityChange);
  void run();
  return stop;
};
