import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';
import * as replayUtils from './replayUtils.mjs';

test('chapters resolve the same source timeline as copied timestamps and preserve a zero start', async (t) => {
  const harness = await createComponentHarness(new URL('./VodChapters.js', import.meta.url), {
    '@mui/material': uiElements, 'humanize-duration': { default: String }, './replayUtils.mjs': replayUtils,
    './ChapterArtwork': { default: 'ChapterArtwork' },
  });
  t.after(() => harness.dispose());
  const parts = [];
  const timestamps = [];
  const chapters = [{ start: 0, end: 20 }, { start: 230, end: 20 }];
  const props = { chapters, chapter: chapters[0], setPart: value => parts.push(value), setChapter: () => {}, setTimestamp: value => timestamps.push(value) };
  const tree = harness.render({ ...props, youtube: [{ part: 1, duration: 100, timelineStartSeconds: 20 }, { part: 2, duration: 50, timelineStartSeconds: 220 }] });
  findElements(tree, node => node.type === 'MenuItem')[1].props.onClick();
  assert.deepEqual({ ...parts[0] }, { part: 2, timestamp: 10 });
  const custom = harness.render(props);
  findElements(custom, node => node.type === 'MenuItem')[0].props.onClick();
  assert.equal(timestamps[0], 0);
});
