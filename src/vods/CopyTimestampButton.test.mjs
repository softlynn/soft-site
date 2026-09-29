import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Box, Snackbar } from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';

for (const denied of [false, true]) {
  test(`timestamp copy ${denied ? 'provides a selectable link when denied' : 'announces success'}`, async (t) => {
    const copied = [];
    const harness = await createComponentHarness(new URL('./CopyTimestampButton.js', import.meta.url), {
      '@mui/material': uiElements, '@mui/icons-material/ContentCopy': { default: 'CopyIcon' }, './MobileDialog': { default: 'Dialog' },
    }, { navigator: { clipboard: { writeText: async value => { if (denied) throw new Error('NotAllowedError'); copied.push(value); } } } });
    t.after(() => harness.dispose());
    const url = 'https://example.test/123?t=2m10s';
    const tree = harness.render({ url });
    await findElements(tree, node => node.type === 'IconButton')[0].props.onClick();
    const updated = await harness.settle();
    assert.equal(findElements(updated, node => node.type === 'Snackbar')[0].props.open, !denied);
    assert.equal(findElements(updated, node => node.type === 'Dialog')[0].props.open, denied);
    if (denied) assert.equal(findElements(updated, node => node.type === 'TextField')[0].props.value, url);
    else assert.deepEqual(copied, [url]);
  });
}

test('copy success renders with the site CSS-variable background in both themes', async (t) => {
  const harness = await createComponentHarness(new URL('./CopyTimestampButton.js', import.meta.url), {
    '@mui/material': uiElements, '@mui/icons-material/ContentCopy': { default: 'CopyIcon' }, './MobileDialog': { default: 'Dialog' },
  }, { navigator: { clipboard: { writeText: async () => {} } } });
  t.after(() => harness.dispose());
  const tree = harness.render({ url: 'https://example.test/123?t=10s' });
  await findElements(tree, node => node.type === 'IconButton')[0].props.onClick();
  const updated = await harness.settle();
  const snackbar = findElements(updated, node => node.type === 'Snackbar')[0];
  // Render the actual MUI notification, not the harness's host placeholders.
  const toMui = node => {
    if (node == null || typeof node !== 'object') return node;
    const { children, ...props } = node.props;
    const Component = { Snackbar, Box }[node.type];
    assert.ok(Component, `unexpected notification component ${node.type}`);
    return createElement(Component, props, ...(Array.isArray(children) ? children : [children]).map(toMui));
  };
  for (const mode of ['dark', 'light']) {
    const theme = createTheme({ palette: { mode, background: { default: 'var(--soft-bg)', paper: 'var(--soft-surface)' } } });
    const html = renderToStaticMarkup(createElement(ThemeProvider, { theme }, toMui(snackbar)));
    assert.match(html, /Timestamp copied/);
  }
});
