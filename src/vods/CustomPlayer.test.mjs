import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';

const setup = async (t) => {
  const createdFiles = [];
  const revokedUrls = [];
  const harness = await createComponentHarness(new URL('./CustomPlayer.js', import.meta.url), {
    'can-autoplay': { default: { video: async () => ({ result: true }) } },
    '@mui/material': uiElements,
    './VideoJS': { default: 'VideoJS' },
    '../utils/helpers': { toSeconds: () => 100 },
    '../config/site': { CDN_BASE: '' },
  }, { URL: {
    createObjectURL: file => { createdFiles.push(file); return `blob:recording-${createdFiles.length}`; },
    revokeObjectURL: url => revokedUrls.push(url),
  } });
  t.after(() => harness.dispose());
  const props = { playerRef: { current: null }, type: 'manual', vod: { id: '123' }, setDelay: () => {} };
  const tree = harness.render(props);
  const input = findElements(tree, node => node.type === 'input' && node.props.type === 'file')[0];
  return { harness, createdFiles, revokedUrls, select: file => input.props.onChange({ target: { files: file ? [file] : [] } }) };
};

for (const [name, type] of [['recording.MKV', ''], ['recording.mkv', 'application/octet-stream'], ['recording.mp4', ''], ['recording.webm', 'video/webm']]) {
  test(`local recording picker accepts ${name} with ${type || 'missing MIME'}`, async (t) => {
    const { select, createdFiles, harness } = await setup(t);
    const file = { name, type };
    select(file);
    const tree = await harness.settle();
    assert.equal(createdFiles[0], file);
    assert.equal(findElements(tree, node => node.type === 'Alert').length, 0);
  });
}

test('local recording picker rejects non-video files and cancellation keeps the current source', async (t) => {
  const { select, createdFiles, revokedUrls, harness } = await setup(t);
  for (const file of [{ name: 'notes.txt', type: '' }, { name: 'script.mkv', type: 'text/javascript' }, { name: 'constructor', type: '' }, { name: 'mp4', type: '' }]) {
    select(file);
    const tree = await harness.settle();
    assert.equal(createdFiles.length, 0);
    assert.equal(findElements(tree, node => node.type === 'Alert').length, 1);
  }
  select({ name: 'clip.mp4', type: 'video/mp4' });
  select(null);
  await harness.settle();
  assert.equal(createdFiles.length, 1);
  assert.equal(revokedUrls.length, 0);
  select({ name: 'next.mp4', type: 'video/mp4' });
  await harness.settle();
  assert.equal(createdFiles.length, 2);
  assert.equal(revokedUrls[0], 'blob:recording-1');
});
