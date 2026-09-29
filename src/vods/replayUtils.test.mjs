import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYouTubeTimeline, findReplayEnd, getPlaybackTime, indexEmotes, resolvePlaybackPosition } from './replayUtils.mjs';

test('chat seek includes simultaneous messages and handles either end of a log', () => {
  const comments = [1, 10, 10, 50].map(content_offset_seconds => ({ content_offset_seconds }));
  assert.equal(findReplayEnd(comments, 0), 0);
  assert.equal(findReplayEnd(comments, 10), 3);
  assert.equal(findReplayEnd(comments, 100), 4);
  assert.equal(findReplayEnd([], 10), 0);
});

test('emote lookup preserves aliases and first match precedence', () => {
  const first = { name: 'Wave', code: 'Hi', id: 'one' };
  const index = indexEmotes([first, { name: 'Wave', id: 'two' }, null]);
  assert.equal(index.get('Wave'), first);
  assert.equal(index.get('Hi'), first);
  assert.equal(index.get('missing'), undefined);
});

test('multipart links clamp invalid parts and resolve global timestamps', () => {
  const videos = [{ part: 1, duration: 100 }, { part: 2, duration: 50 }];
  assert.deepEqual(resolvePlaybackPosition(videos, 'garbage'), { part: 1, timestamp: 0 });
  assert.deepEqual(resolvePlaybackPosition(videos, -1), { part: 1, timestamp: 0 });
  assert.deepEqual(resolvePlaybackPosition(videos, 99), { part: 2, timestamp: 0 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 110), { part: 2, timestamp: 10 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 100), { part: 2, timestamp: 0 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 999), { part: 2, timestamp: 49.9 });
  assert.deepEqual(resolvePlaybackPosition([{ part: 1, duration: 0 }, videos[1]], 1, 20), { part: 1, timestamp: 20 });
});

test('global timestamps invert part origins and skip hidden gaps without collapsing the timeline', () => {
  const videos = [
    { part: 1, duration: 100, timelineStartSeconds: 20 },
    { part: 2, duration: 50, timelineStartSeconds: 220 },
  ];
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 30), { part: 1, timestamp: 10 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 150), { part: 2, timestamp: 0 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 230), { part: 2, timestamp: 10 });
  assert.deepEqual(resolvePlaybackPosition(videos, 1, 999), { part: 2, timestamp: 49.9 });
  assert.deepEqual(resolvePlaybackPosition(videos, 2), { part: 2, timestamp: 0 });
});

test('complete known-duration archives preserve their legacy prefix and round-trip every part clock', () => {
  const videos = buildYouTubeTimeline([{ part: 1, duration: '100' }, { part: 2, duration: 50 }], '00:02:50');
  assert.deepEqual(videos.map(video => video.timelineStartSeconds), [20, 120]);
  for (const part of [1, 2]) {
    for (const timestamp of [0, 10, 49]) {
      assert.deepEqual(resolvePlaybackPosition(videos, 1, getPlaybackTime(videos, part, timestamp)), { part, timestamp });
    }
  }
});

test('raw order includes hidden media even after admin renumbers visible parts', () => {
  const videos = buildYouTubeTimeline([
    { part: 2, adminOrder: 3, duration: 50 },
    { part: 1, adminOrder: 1, duration: 100 },
    { part: 2, adminOrder: 2, duration: 75, unpublished: true },
  ], 245);
  assert.deepEqual(videos.map(video => video.timelineStartSeconds), [20, 120, 195]);
  const visible = videos.filter(video => !video.unpublished).map((video, index) => ({ ...video, part: index + 1 }));
  assert.equal(getPlaybackTime(visible, 2, 10), 205);
  assert.deepEqual(resolvePlaybackPosition(visible, 1, 205), { part: 2, timestamp: 10 });
});

test('unknown predecessors and missing original parts leave later timing unavailable until an explicit origin', () => {
  const unknown = buildYouTubeTimeline([
    { part: 1, duration: 0 }, { part: 2, duration: 100 },
    { part: 3, duration: 50, timelineStartSeconds: '300' }, { part: 4, duration: 50 },
  ], 600);
  assert.deepEqual(unknown.map(video => video.timelineStartSeconds), [0, null, 300, 350]);
  assert.equal(getPlaybackTime(unknown, 2, 10), null);
  assert.equal(getPlaybackTime(unknown, 3, 10), 310);
  const missing = buildYouTubeTimeline([{ part: 2, duration: 100 }, { part: 3, duration: 50 }], 200);
  assert.deepEqual(missing.map(video => video.timelineStartSeconds), [null, null]);
  assert.deepEqual(resolvePlaybackPosition(missing, 2, 160), { part: 3, timestamp: 0 });
});

test('valid explicit origins override legacy estimates and invalid clock values are unavailable', () => {
  const videos = buildYouTubeTimeline([
    { part: 1, duration: 100, timelineStartSeconds: 0 },
    { part: 2, duration: 50, timelineStartSeconds: '125' },
  ], 300);
  assert.deepEqual(videos.map(video => video.timelineStartSeconds), [0, 125]);
  assert.equal(getPlaybackTime(videos, 2, 5), 130);
  assert.equal(getPlaybackTime(videos, 2, NaN), null);
  assert.equal(getPlaybackTime(videos, 2, -5), null);
  assert.equal(getPlaybackTime(videos, 3, 0), null);
});
