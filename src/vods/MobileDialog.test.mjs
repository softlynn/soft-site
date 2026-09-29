import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness } from './componentTestHarness.mjs';

test('mobile dialog follows the visible keyboard area and removes its viewport listeners when closed', async (t) => {
  const listeners = new Map();
  const viewportListeners = new Map();
  const window = {
    innerWidth: 390, innerHeight: 844,
    visualViewport: {
      width: 390, height: 844, offsetTop: 0, offsetLeft: 0,
      addEventListener: (name, callback) => viewportListeners.set(name, callback),
      removeEventListener: name => viewportListeners.delete(name),
    },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
  };
  const harness = await createComponentHarness(new URL('./MobileDialog.js', import.meta.url), {
    '@mui/material': { Dialog: 'Dialog', useMediaQuery: () => true },
  }, { window, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  t.after(() => harness.dispose());
  let tree = harness.render({ open: true });
  assert.equal(tree.props.sx?.at(-1)?.height, '844px');
  window.visualViewport.height = 280;
  window.visualViewport.offsetTop = 100;
  viewportListeners.get('resize')();
  tree = await harness.runTimers();
  assert.equal(tree.props.sx.at(-1).height, '280px', 'dialog content stays above the keyboard');
  assert.equal(tree.props.sx.at(-1).top, '100px', 'dialog follows keyboard-induced viewport panning');
  window.visualViewport.offsetTop = 140;
  viewportListeners.get('scroll')();
  tree = await harness.runTimers();
  assert.equal(tree.props.sx.at(-1).top, '140px');
  harness.render({ open: false });
  assert.equal(listeners.size, 0);
  assert.equal(viewportListeners.size, 0);
});

test('desktop dialogs retain their existing sizing and install no viewport listeners', async (t) => {
  const harness = await createComponentHarness(new URL('./MobileDialog.js', import.meta.url), {
    '@mui/material': { Dialog: 'Dialog', useMediaQuery: () => false },
  }, { window: { addEventListener: () => assert.fail('desktop listener') } });
  t.after(() => harness.dispose());
  const tree = harness.render({ open: true, sx: { color: 'inherit' } });
  const styles = Object.assign({}, ...[tree.props.sx].flat().filter(Boolean));
  assert.deepEqual(styles, { color: 'inherit' });
});
