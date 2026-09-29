import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness } from './componentTestHarness.mjs';

test('mobile overlay resizes, keeps portrait while typing, and restores scrolling and listeners on exit', async (t) => {
  const listeners = new Map();
  const viewportListeners = new Map();
  const scrolls = [];
  let dialogOpen = false;
  const activeDialog = { closest: () => null, matches: () => false, getClientRects: () => [{}] };
  const document = {
    documentElement: { style: { overflow: 'auto' } },
    body: { style: { overflow: '', position: '', top: '', width: '' } },
    activeElement: { tagName: 'BODY' }, querySelector: () => dialogOpen ? activeDialog : null,
    querySelectorAll: () => dialogOpen ? [activeDialog] : [],
  };
  const window = {
    scrollY: 80, innerWidth: 390, innerHeight: 844,
    visualViewport: { width: 390, height: 844, addEventListener: (name, callback) => viewportListeners.set(name, callback), removeEventListener: name => viewportListeners.delete(name) },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
    scrollTo: (...position) => scrolls.push(position),
    getComputedStyle: () => ({ visibility: 'visible' }),
  };
  const harness = await createComponentHarness(new URL('./useMobileViewer.js', import.meta.url), {}, {
    document, window, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  let disposed = false;
  t.after(() => { if (!disposed) harness.dispose(); });
  harness.render({ isMobile: true, isPortrait: true }).toggleFullscreen();
  let state = await harness.settle();
  assert.equal(state.mobileViewerFullscreen, true);
  assert.equal(state.fullscreenViewportHeight, '844px');
  assert.equal(document.body.style.top, '-80px');
  assert.equal(document.body.style.position, 'fixed');

  document.activeElement = { tagName: 'INPUT' };
  window.visualViewport.height = 300;
  viewportListeners.get('resize')();
  state = await harness.runTimers();
  assert.equal(state.fullscreenViewportHeight, '300px');
  assert.equal(state.mobileFullscreenSideLayout, false, 'the keyboard is not an orientation change');
  window.innerWidth = 844;
  window.innerHeight = 390;
  window.visualViewport.width = 844;
  window.visualViewport.height = 170;
  listeners.get('orientationchange')();
  state = await harness.runTimers();
  assert.equal(state.mobileFullscreenSideLayout, true, 'physical rotation still updates layout while typing');
  window.innerWidth = 390;
  window.innerHeight = 844;
  window.visualViewport.width = 390;
  window.visualViewport.height = 300;
  listeners.get('orientationchange')();
  state = await harness.runTimers();
  assert.equal(state.mobileFullscreenSideLayout, false, 'a short keyboard viewport can still be portrait');
  document.activeElement = { tagName: 'BODY' };

  dialogOpen = true;
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal((await harness.settle()).mobileViewerFullscreen, true, 'Escape closes a dialog before the overlay');
  dialogOpen = false;
  listeners.get('keydown')({ key: 'Escape' });
  state = await harness.settle();
  assert.equal(state.mobileViewerFullscreen, false);
  assert.equal(document.documentElement.style.overflow, 'auto');
  assert.deepEqual(document.body.style, { overflow: '', position: '', top: '', width: '' });
  assert.deepEqual(scrolls, [[0, 80]]);
  assert.equal(listeners.size, 0);
  assert.equal(viewportListeners.size, 0);

  state.toggleFullscreen();
  await harness.settle();
  harness.dispose();
  disposed = true;
  assert.equal(document.body.style.position, '', 'navigation/unmount also unlocks scrolling');
  assert.equal(listeners.size, 0);
});

for (const closeViewerFirst of [false, true]) {
  test(`mobile overlay and dialog restore scrolling when ${closeViewerFirst ? 'navigation unmounts the viewer first' : 'the dialog closes first'}`, async (t) => {
    const document = {
      documentElement: { style: { overflow: 'auto' } },
      body: { style: { overflow: 'auto', position: '', top: '', width: '' } },
      activeElement: { tagName: 'BODY' }, querySelector: () => null,
    };
    const window = {
      scrollY: 45, innerWidth: 390, innerHeight: 844,
      addEventListener() {}, removeEventListener() {}, scrollTo() {},
    };
    const harness = await createComponentHarness(new URL('./useMobileViewer.js', import.meta.url), {}, {
      document, window, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    });
    let disposed = false;
    t.after(() => { if (!disposed) harness.dispose(); });
    harness.render({ isMobile: true, isPortrait: true }).toggleFullscreen();
    await harness.settle();
    // MUI ModalManager snapshots inline body overflow when a dialog opens.
    // It restores that snapshot when the dialog closes or the route unmounts.
    const dialogPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeDialog = () => { document.body.style.overflow = dialogPreviousOverflow; };
    if (!closeViewerFirst) closeDialog();
    harness.dispose();
    disposed = true;
    if (closeViewerFirst) closeDialog();
    assert.equal(document.body.style.overflow, 'auto');
    assert.equal(document.body.style.position, '');
    assert.equal(document.documentElement.style.overflow, 'auto');
  });
}

for (const scenario of [
  { name: 'a hidden VideoJS dialog', hidden: true, visible: false, exits: true },
  { name: 'a dialog hidden by CSS', visible: false, exits: true },
  { name: 'a visibility-hidden dialog', visible: true, visibility: 'hidden', exits: true },
  { name: 'a visible non-closeable VideoJS error', visible: true, error: true, exits: true },
  { name: 'open playback settings', visible: true, exits: false },
  { name: 'open VideoJS caption settings', visible: true, exits: false },
  { name: 'an open part listbox', role: 'listbox', visible: true, exits: false },
]) {
  test(`Escape ${scenario.exits ? 'exits the viewer past' : 'leaves first dismissal to'} ${scenario.name}`, async (t) => {
    const listeners = new Map();
    const overlay = {
      closest: () => scenario.hidden ? {} : null,
      matches: selector => selector === '.vjs-error-display' && Boolean(scenario.error),
      getClientRects: () => scenario.visible ? [{}] : [],
    };
    const document = {
      documentElement: { style: {} }, body: { style: {} }, activeElement: { tagName: 'BUTTON' },
      querySelector: () => overlay,
      querySelectorAll: selector => selector.includes(scenario.role || 'dialog') ? [overlay] : [],
    };
    const window = {
      scrollY: 0, innerWidth: 320, innerHeight: 740,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name), scrollTo() {},
      getComputedStyle: () => ({ visibility: scenario.visibility || 'visible' }),
    };
    const harness = await createComponentHarness(new URL('./useMobileViewer.js', import.meta.url), {}, {
      document, window, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    });
    t.after(() => harness.dispose());
    harness.render({ isMobile: true, isPortrait: true }).toggleFullscreen();
    await harness.settle();
    listeners.get('keydown')({ key: 'Escape' });
    assert.equal((await harness.settle()).mobileViewerFullscreen, !scenario.exits);
  });
}

test('Escape exits with a focused video control that stops keydown bubbling, but leaves native fullscreen first', async (t) => {
  const listeners = new Map();
  const document = {
    documentElement: { style: {} }, body: { style: {} }, activeElement: { tagName: 'BUTTON' },
    querySelector: () => null, querySelectorAll: () => [], fullscreenElement: {},
  };
  const window = {
    scrollY: 0, innerWidth: 320, innerHeight: 740,
    addEventListener: (name, callback, capture) => listeners.set(`${name}:${Boolean(capture)}`, callback),
    removeEventListener: (name, callback, capture) => listeners.delete(`${name}:${Boolean(capture)}`), scrollTo() {},
    getComputedStyle: () => ({ visibility: 'visible' }),
  };
  const harness = await createComponentHarness(new URL('./useMobileViewer.js', import.meta.url), {}, {
    document, window, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  t.after(() => harness.dispose());
  harness.render({ isMobile: true, isPortrait: true }).toggleFullscreen();
  await harness.settle();
  // VideoJS stops this event at its control, after window capture but before
  // window bubbling. Model that browser ordering without mocking player code.
  listeners.get('keydown:true')?.({ key: 'Escape' });
  assert.equal((await harness.settle()).mobileViewerFullscreen, true);
  document.fullscreenElement = null;
  listeners.get('keydown:true')?.({ key: 'Escape' });
  assert.equal((await harness.settle()).mobileViewerFullscreen, false);
  assert.equal(listeners.size, 0);
});
