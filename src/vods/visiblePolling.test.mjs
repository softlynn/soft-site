import test from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePolling } from './visiblePolling.mjs';

const createHost = () => {
  const timers = new Map();
  const listeners = new Set();
  let timerId = 0;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const document = {
    hidden: false,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  return {
    host: {
      document,
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: id => timers.delete(id),
    },
    timers, listeners, flush,
    async tick() {
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      await flush();
    },
    async show(visible) {
      document.hidden = !visible;
      for (const listener of [...listeners]) listener();
      await flush();
    },
  };
};

test('hidden and canceled readiness checks preserve the visible attempt budget across a rapid return', async (t) => {
  const state = createHost();
  const signals = [];
  const values = [];
  let finishCanceled;
  let finished = 0;
  const stop = startVisiblePolling({
    poll: ({ signal }) => {
      signals.push(signal);
      if (signals.length === 2) return new Promise(resolve => { finishCanceled = resolve; });
      return signals.length === 1 ? 'pending' : 'ready';
    },
    onResult: value => { values.push(value); return value === 'ready'; },
    onFinish: () => { finished += 1; },
    intervalMs: 2500,
    maxAttempts: 2,
  }, state.host);
  t.after(stop);
  await state.flush();
  await state.tick();
  assert.equal(signals.length, 2);
  await state.show(false);
  assert.equal(signals[1].aborted, true);
  for (let i = 0; i < 30; i += 1) await state.tick();
  assert.equal(signals.length, 2);
  await state.show(true);
  assert.equal(signals.length, 2, 'the aborted call must settle before another starts');
  finishCanceled('stale');
  await state.flush();
  assert.deepEqual(values, ['pending', 'ready']);
  assert.equal(signals.length, 3, 'a canceled attempt must not use the final readiness attempt');
  assert.equal(finished, 1);
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

test('visible readiness failures stop at their retry budget and release timers and listeners', async (t) => {
  const state = createHost();
  let errors = 0;
  let calls = 0;
  const stop = startVisiblePolling({
    poll: async () => { calls += 1; throw new Error('metadata pending'); },
    onError: () => { errors += 1; },
    intervalMs: 2500,
    maxAttempts: 2,
  }, state.host);
  t.after(stop);
  await state.flush();
  await state.tick();
  await state.tick();
  await state.show(false);
  await state.show(true);
  assert.equal(calls, 2);
  assert.equal(errors, 2);
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});
