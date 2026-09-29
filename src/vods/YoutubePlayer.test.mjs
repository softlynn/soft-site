import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness } from './componentTestHarness.mjs';
import * as replayUtils from './replayUtils.mjs';

for (const origin of [220, null]) {
  test(`YouTube player reports ${origin === null ? 'unavailable' : 'source'} time for the selected part`, async (t) => {
    const harness = await createComponentHarness(new URL('./YoutubePlayer.js', import.meta.url), {
      'can-autoplay': { default: { video: async () => ({ result: true }) } },
      'react-youtube': { default: 'Youtube' },
      './replayUtils.mjs': replayUtils,
    });
    t.after(() => harness.dispose());
    const observed = [];
    const loads = [];
    const player = { getCurrentTime: () => 10, getPlayerState: () => 1, loadVideoById: (...args) => loads.push(args) };
    const tree = harness.render({
      youtube: [{ id: 'first', part: 1, duration: 100, timelineStartSeconds: 20 }, { id: 'second', part: 2, duration: 50, timelineStartSeconds: origin }],
      playerRef: { current: null }, part: { part: 2, timestamp: 10 },
      setCurrentTime: value => observed.push(value), setPlaying: () => {}, setPart: () => {}, delay: 0,
    });
    tree.props.onReady({ target: player });
    tree.props.onPlay();
    assert.deepEqual(loads, [['second', 10]], 'ordinal part navigation still loads local seconds');
    assert.equal(observed.at(-1), origin === null ? null : 230);
  });
}
