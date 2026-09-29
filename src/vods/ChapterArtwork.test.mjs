import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';
import * as replayUtils from './replayUtils.mjs';

const artworkDependencies = {
  '@mui/material': uiElements,
  '@mui/icons-material/SportsEsportsRounded': { default: 'GameIcon' },
};

for (const menu of ['ChaptersMenu', 'VodChapters']) {
  test(`${menu} replaces failed remote artwork locally without changing its dimensions`, async (t) => {
    const chapter = { gameId: 'game', name: 'Game', start: 0, end: 60, image: 'https://art.invalid/game-{width}x{height}.jpg' };
    const menuHarness = await createComponentHarness(new URL(`./${menu}.js`, import.meta.url), {
      '@mui/material': uiElements,
      '@mui/icons-material/KeyboardArrowDownRounded': { default: 'ChapterChevronIcon' },
      'humanize-duration': { default: String },
      '../utils/CustomLink': { default: 'CustomLink' },
      '../utils/helpers': { toHMS: String },
      './replayUtils.mjs': replayUtils,
      './ChapterArtwork': { default: 'ChapterArtwork' },
    });
    t.after(() => menuHarness.dispose());
    const menuTree = menuHarness.render({
      vod: { id: '123', chapters: [chapter], youtube: [{ id: 'video' }] },
      chapters: [chapter], chapter,
    });
    const artwork = findElements(menuTree, node => node.type === 'ChapterArtwork');
    assert.equal(artwork.length, menu === 'VodChapters' ? 1 : 2, 'chapter artwork remains in the menu and any artwork-based trigger');
    for (const [index, node] of artwork.entries()) {
      const harness = await createComponentHarness(new URL('./ChapterArtwork.js', import.meta.url), artworkDependencies);
      t.after(() => harness.dispose());
      const tree = harness.render(node.props);
      const image = findElements(tree, item => item.type === 'img')[0];
      assert.equal(image.props.src, 'https://art.invalid/game-40x53.jpg', 'legacy artwork placeholders still resolve');
      assert.equal(typeof image.props.onError, 'function', 'failed artwork must have a local fallback');
      const size = { width: tree.props.sx.width, height: tree.props.sx.height };
      assert.deepEqual(size, menu === 'ChaptersMenu' && index === 0 ? { width: 32, height: 42 } : { width: 40, height: 53 });
      image.props.onError();
      const fallback = await harness.settle();
      assert.equal(findElements(fallback, item => item.type === 'img').length, 0, 'the fallback must not make another image request');
      assert.equal(fallback.props['aria-hidden'], true, 'decorative fallback stays out of the accessibility tree');
      assert.deepEqual({ width: fallback.props.sx.width, height: fallback.props.sx.height }, size);
    }
  });
}

test('chapter artwork uses a local fallback for missing sources and recovers for a new source', async (t) => {
  const harness = await createComponentHarness(new URL('./ChapterArtwork.js', import.meta.url), artworkDependencies);
  t.after(() => harness.dispose());
  const empty = harness.render({ image: '', width: 32, height: 42, borderRadius: '8px' });
  assert.equal(findElements(empty, node => node.type === 'img').length, 0);
  assert.equal(empty.props.sx.width, 32);
  assert.equal(empty.props.sx.height, 42);
  assert.equal(empty.props.sx.borderRadius, '8px');

  const first = harness.render({ image: 'https://art.invalid/expired.jpg' });
  const oldImage = findElements(first, node => node.type === 'img')[0];
  oldImage.props.onError();
  assert.equal(findElements(await harness.settle(), node => node.type === 'img').length, 0);

  const next = harness.render({ image: 'https://art.invalid/fresh.jpg' });
  assert.equal(findElements(next, node => node.type === 'img')[0].props.src, 'https://art.invalid/fresh.jpg');
  oldImage.props.onError();
  assert.equal(findElements(await harness.settle(), node => node.type === 'img')[0].props.src, 'https://art.invalid/fresh.jpg', 'a late old error cannot hide fresh artwork');
});
