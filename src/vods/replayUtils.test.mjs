import test from 'node:test';
import assert from 'node:assert/strict';
import { findReplayEnd, indexEmotes, resolvePlaybackPosition } from './replayUtils.mjs';

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
