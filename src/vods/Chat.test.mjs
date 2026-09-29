import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';
import * as replayUtils from './replayUtils.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const message = (id, offset = 10) => ({
  id, content_offset_seconds: offset, display_name: 'Viewer',
  message: [{ text: 'Wave GlobalWave' }], user_badges: [{ _id: 'moderator', version: '1' }],
});
const messageIds = tree => findElements(tree, node => node.key?.startsWith('message-')).map(node => node.key);

const createFixture = async (t, { paginated = false, longLog = false, onRender, youtube, part, comments } = {}) => {
  const emotes = deferred();
  const badges = deferred();
  const globalEmotes = deferred();
  let commentReads = 0;
  let clock = longLog ? 600 : 20;
  const harness = await createComponentHarness(new URL('./Chat.js', import.meta.url), {
    '@mui/material': uiElements,
    'simplebar-react': { default: 'SimpleBar' },
    '../utils/Loading': { default: 'Loading' },
    '@mui/icons-material/KeyboardDoubleArrowLeftRounded': { default: 'Left' },
    '@mui/icons-material/KeyboardDoubleArrowRightRounded': { default: 'Right' },
    '@mui/material/Collapse': { collapseClasses: { wrapper: 'wrapper' } },
    'react-twemoji': { default: 'Twemoji' },
    './Settings': { default: 'Settings' },
    '../utils/helpers': { toHHMMSS: String },
    '@mui/icons-material/Settings': { default: 'SettingsIcon' },
    './MessageTooltip': { default: 'MessageTooltip' },
    '../config/site': { BTTV_EMOTE_CDN: 'https://cdn.example' },
    '../utils/ThemeModeToggle': { default: 'ThemeModeToggle' },
    './replayUtils.mjs': replayUtils,
    '../api/vodsApi': {
      getEmotes: () => emotes.promise,
      getBadges: () => badges.promise,
      getVodComments: async (_, { cursor } = {}) => {
        commentReads++;
        return {
          comments: comments || (longLog ? Array.from({ length: 1200 }, (_, index) => message(`message-${index + 1}`, index + 1))
            : [message(cursor ? 'message-two' : 'message-one')]),
          cursor: paginated && !cursor ? 'next-page' : null,
        };
      },
    },
  }, { fetch: async () => ({ json: () => globalEmotes.promise }) }, onRender);
  t.after(() => harness.dispose());
  harness.render({
    vodId: '123', isPortrait: false, playing: { playing: longLog, ready: true },
    playerRef: { current: { currentTime: () => clock, paused: () => !longLog, getCurrentTime: () => clock, getPlayerState: () => longLog ? 1 : 2 } },
    delay: 0, userChatDelay: 0, youtube, part,
  });
  return { harness, emotes, badges, globalEmotes, reads: () => commentReads, setClock: value => { clock = value; } };
};

for (const paginated of [false, true]) {
test(`already visible paused ${paginated ? 'paginated' : 'static'} chat gains late emotes and badges without losing history`, async (t) => {
  const { harness, emotes, badges, globalEmotes, reads } = await createFixture(t, { paginated });
  const before = await harness.runTimers();
  assert.equal(findElements(before, node => node.key === 'message-one').length, 1);
  assert.equal(findElements(before, node => node.type === 'img').length, 0);

  const savedEmotes = { ffz_emotes: [{ id: 'wave', name: 'Wave' }], '7tv_emotes': [] };
  emotes.resolve({ data: [savedEmotes] });
  badges.resolve({ channel: [], global: [{ set_id: 'moderator', versions: [{
    id: '1', image_url_1x: 'https://badge.example/1', image_url_2x: 'https://badge.example/2', image_url_4x: 'https://badge.example/4',
  }] }] });
  const after = await harness.settle();
  assert.equal(findElements(after, node => node.key === 'message-one').length, 1);
  assert.equal(findElements(after, node => node.type === 'img' && node.props.alt === 'Wave').length, 1);
  assert.equal(findElements(after, node => node.type === 'img' && node.props.src === 'https://badge.example/1').length, 1);
  assert.equal(reads(), paginated ? 2 : 1);
  globalEmotes.resolve({ emotes: [{ id: 'global', name: 'GlobalWave' }] });
  const withGlobal = await harness.settle();
  assert.equal(findElements(withGlobal, node => node.type === 'img' && node.props.alt === 'GlobalWave').length, 1);
  assert.equal(findElements(withGlobal, node => node.key === 'message-one').length, 1);
  assert.equal(savedEmotes['7tv_emotes'].length, 0, 'global lookup must not mutate the saved emote cache');
  assert.equal(reads(), paginated ? 2 : 1);
});
}

test('YouTube chat uses the source origin after hidden parts instead of the visible duration sum', async (t) => {
  const { harness } = await createFixture(t, {
    youtube: [{ part: 1, duration: 100, timelineStartSeconds: 20 }, { part: 2, duration: 50, timelineStartSeconds: 220 }],
    part: { part: 2, timestamp: 0 },
    comments: [message('message-before', 225), message('message-current', 240), message('message-future', 250)],
  });
  assert.deepEqual(messageIds(await harness.runTimers()), ['message-before', 'message-current']);
});

test('scrolling up keeps a bounded history through late assets and catches up on return to bottom', async (t) => {
  let onScroll;
  const scrollNode = {
    scrollTop: 5500, scrollHeight: 6000, clientHeight: 500,
    addEventListener: (_, callback) => { onScroll = callback; },
    removeEventListener: () => {},
  };
  const { harness, emotes, reads, setClock } = await createFixture(t, {
    longLog: true,
    onRender: tree => {
      const scroller = findElements(tree, node => node.type === 'SimpleBar')[0];
      if (scroller) scroller.props.scrollableNodeProps.ref.current = scrollNode;
    },
  });
  const before = await harness.runTimers();
  const initialIds = messageIds(before);
  assert.equal(initialIds.length, 500);
  assert.equal(initialIds[0], 'message-101');
  const initialReads = reads();
  scrollNode.scrollTop = 0;
  onScroll();
  await harness.settle();
  setClock(1100);
  assert.deepEqual(messageIds(await harness.runIntervals()), initialIds);
  emotes.resolve({ data: [{ ffz_emotes: [{ id: 'wave', name: 'Wave' }] }] });
  const refreshed = await harness.settle();
  assert.deepEqual(messageIds(refreshed), initialIds);
  assert.equal(findElements(refreshed, node => node.type === 'img' && node.props.alt === 'Wave').length, 500);
  assert.equal(scrollNode.scrollTop, 0);
  assert.equal(reads(), initialReads);
  scrollNode.scrollTop = scrollNode.scrollHeight;
  onScroll();
  await harness.settle();
  const caughtUp = messageIds(await harness.runIntervals());
  assert.equal(caughtUp.length, 500);
  assert.equal(caughtUp[0], 'message-601');
  assert.equal(caughtUp.at(-1), 'message-1100');
});
