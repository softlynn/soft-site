import test from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { createComponentHarness, findElements, uiElements } from './componentTestHarness.mjs';

const setup = async (t, overrides = {}) => {
  const listeners = new Map();
  const edits = [];
  let focusCount = 0;
  let overlays = [];
  const body = { tagName: 'BODY', closest: () => null };
  const document = {
    activeElement: body,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
    querySelectorAll: () => overlays,
  };
  const input = { focus: () => { focusCount += 1; } };
  const harness = await createComponentHarness(new URL('./ArchiveControls.js', import.meta.url), {
    '@mui/material': Object.assign(Object.create(uiElements), { useMediaQuery: () => false }),
    '@mui/x-date-pickers/DatePicker': { DatePicker: 'DatePicker' },
    '@mui/x-date-pickers/LocalizationProvider': { LocalizationProvider: 'LocalizationProvider' },
    '@mui/x-date-pickers/AdapterDayjs': { AdapterDayjs: class {} },
    dayjs: { default: dayjs },
    '@mui/icons-material/VideoLibraryRounded': { default: 'LibraryIcon' },
    '@mui/icons-material/TuneRounded': { default: 'TuneIcon' },
    '@mui/icons-material/SearchRounded': { default: 'SearchIcon' },
    '../config/site': { START_DATE: '2020-01-01' },
  }, { document }, tree => {
    for (const field of findElements(tree, node => node.type === 'TextField')) {
      if (field.props.inputRef) field.props.inputRef.current = input;
    }
  });
  t.after(() => harness.dispose());
  const props = {
    filter: 'Default', filters: ['Default', 'Title', 'Game', 'Date'], totalVods: 23,
    filterTitle: '', filterGame: '', filterStartDate: dayjs('2020-01-01'), filterEndDate: dayjs('2026-09-29'),
    changeFilter: event => edits.push(['filter', event.target.value]),
    handleTitleChange: event => edits.push(['title', event.target.value]),
    handleGameChange: event => edits.push(['game', event.target.value]),
    onResetFilters: () => edits.push(['reset']),
    ...overrides,
  };
  return {
    harness, props, edits, listeners, document, body,
    focusCount: () => focusCount,
    overlays: value => { overlays = value; },
    press: options => {
      let prevented = false;
      listeners.get('keydown')?.({ key: 'k', ctrlKey: true, target: body, preventDefault: () => { prevented = true; }, ...options });
      return prevented;
    },
  };
};

test('desktop archive exposes title search immediately and typing selects title mode', async (t) => {
  const state = await setup(t);
  const tree = state.harness.render(state.props);
  const searches = findElements(tree, node => node.type === 'TextField' && node.props.type === 'search');
  assert.equal(searches.length, 1, 'Default mode still offers the primary title search');
  searches[0].props.onChange({ target: { value: 'cozy stream' } });
  assert.deepEqual(state.edits, [['filter', 'Title'], ['title', 'cozy stream']]);
});

test('Control or Command K focuses archive search without stealing input from editing or visible dialogs', async (t) => {
  const state = await setup(t);
  state.harness.render(state.props);
  assert.equal(state.press(), true);
  assert.equal(state.focusCount(), 1);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }, { closest: () => ({}) }]) {
    assert.equal(state.press({ target }), false);
  }
  for (const options of [{ ctrlKey: false }, { key: '/' }, { key: 'x' }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { repeat: true }]) {
    assert.equal(state.press(options), false);
  }
  state.overlays([{ getClientRects: () => [{}], closest: () => null }]);
  assert.equal(state.press(), false);
  assert.equal(state.focusCount(), 1);
  state.overlays([{ getClientRects: () => [], closest: () => null }]);
  assert.equal(state.press(), true, 'a closed dialog must not disable the shortcut');
  assert.equal(state.press({ ctrlKey: false, metaKey: true }), true, 'Command K supports macOS keyboards');
  state.harness.dispose();
  assert.equal(state.listeners.size, 0);
});

test('active archive filters can reset and title search remains available during date filtering', async (t) => {
  const state = await setup(t, { filter: 'Date' });
  const tree = state.harness.render(state.props);
  const search = findElements(tree, node => node.type === 'TextField' && node.props.type === 'search')[0];
  assert.ok(search);
  search.props.onChange({ target: { value: 'summer' } });
  assert.deepEqual(state.edits, [['filter', 'Title'], ['title', 'summer']]);
  findElements(tree, node => node.type === 'Button' && node.props.children === 'Clear filters')[0].props.onClick();
  assert.deepEqual(state.edits.at(-1), ['reset']);
  findElements(tree, node => node.type === 'Select')[0].props.onChange({ target: { value: 'Default' } });
  assert.deepEqual(state.edits.at(-1), ['reset']);
});
