// A table cell as a native text view (#5359): its runs are the footnote-size words the React cell draws (semibold in the header, aligned as the column says), and its menu is Ask · Select Cell · Select Table; with the in-place selection off the table is as it was.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const gatePath = '../mobile/src/presentation/nativeGate';
const replyPath = '../mobile/src/replyContext';
const runsPath = '../mobile/src/presentation/proseRuns';
const parsePath = '../shared/markdownParse.mjs';
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { nativeGate, MENU_WAIT } = await import(gatePath);
const { ReplyContext } = await import(replyPath);
const { cellRuns } = await import(runsPath);
const parse = await import(parsePath);

const TABLE = '| Item | Price |\n|:---:|---:|\n| **Pen** | 3 |\n| [Ink](https://a.io) | `4` |';
const COLORS = { ink: '#111111', link: '#0a60ff', codeBg: '#eeeeee' };

async function mount(node: any) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return () => act(async () => root.unmount());
}
const cells = () => (g.__nativeRuns as any[]).filter((p) => p.menuEntries?.some((e: any) => e.id === 'selectCell'));
const textOf = (p: any) => p.runs.map((r: any) => r.t).join('');

test('a cell’s runs are footnote-size words: semibold in the header, as marked inside, aligned as its column says, no space after', () => {
  const table = (parse as any).parseMarkdown(TABLE).children[0];
  const [head, body] = table.children;
  const header = cellRuns(head.children[0], true, 'center', COLORS, 2);
  assert.deepEqual(header, [{ t: 'Item', fs: '26', lh: '36', col: '#111111', b: '1', ps: '0', al: 'c' }]);
  const price = cellRuns(head.children[1], true, 'right', COLORS);
  assert.equal(price[0].al, 'r');
  const strong = cellRuns(body.children[0], false, 'center', COLORS);
  assert.deepEqual(
    strong.map((r: any) => [r.t, r.b, r.al, r.fs]),
    [['Pen', '1', 'c', '13']],
  );
  const mixed = cellRuns(table.children[2].children[0], false, null, COLORS);
  assert.equal(mixed[0].u, 'https://a.io');
  assert.equal(mixed[0].al, undefined, 'left is the default, and says nothing');
  const code = cellRuns(table.children[2].children[1], false, 'right', COLORS);
  assert.deepEqual([code[0].c, code[0].cs, code[0].bg], ['1', '13', '#eeeeee']);
});

test('with the in-place selection on every cell is a native run; its menu is Ask, Select Cell, Select Table, and Ask hands the cell’s words over', async () => {
  setInPlaceSelection(true);
  try {
    g.__nativeRuns = [];
    const asked: string[] = [];
    const done = await mount(
      createElement(
        ReplyContext.Provider,
        { value: (s: string) => asked.push(s) },
        createElement(MessageBubble, { role: 'assistant', text: TABLE }),
      ),
    );
    const seen = cells();
    assert.deepEqual(seen.map(textOf).slice(0, 6), ['Item', 'Price', 'Pen', '3', 'Ink', '4']);
    const entries = seen[0].menuEntries;
    assert.deepEqual(
      entries.map((e: any) => e.id),
      ['ask', 'selectCell', 'selectTable'],
    );
    assert.deepEqual(entries[0], { id: 'ask', title: 'Ask', first: '1', selection: '1' });
    assert.deepEqual(
      entries[1],
      { id: 'selectCell', title: 'Select Cell', near: '1', native: 'selectAll' },
      'the view selects the whole cell itself, and the menu draws it right after Copy',
    );
    // no table-wide menu on a long press that a shown native cell answers: it would open a second menu over a selection in a cell. The press wrapper
    // itself stays: without it the sideways scroller never takes a drag that starts over a native cell (the wide table did not scroll)
    g.__actionSheet = undefined;
    const holders = [...document.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress);
    const gridHolder: any = holders.filter((b) => b.querySelector('[role="grid"]')).at(-1);
    assert.ok(gridHolder, 'the grid sits in a press wrapper, so the scroller takes a drag over its native cells');
    mock.timers.enable({ apis: ['setTimeout'] });
    nativeGate.touch(true);
    await act(async () => gridHolder.__press.onLongPress());
    // the cell shows its own menu: the table's stays shut for as long as the view may take
    nativeGate.answer();
    await act(async () => mock.timers.tick(MENU_WAIT));
    assert.equal(g.__actionSheet, undefined, 'its long press opens nothing over a shown native cell');
    // a touch that starts on the table clears the claim of the one before (the table's scroller, outer to its cells): the table's menu is the answer unless a shown cell claims it again
    const scroller: any = [...document.querySelectorAll('div')]
      .filter((d: any) => d.__touchStartCapture && d.querySelector('[role="grid"]'))
      .at(-1);
    await act(async () => scroller.__touchStartCapture());
    assert.equal(nativeGate.touchedNative(), false, 'a new touch on the table starts with no native view under it');
    // a press on a cell that is not native yet is never left with nothing: the table's menu
    await act(async () => gridHolder.__press.onLongPress());
    assert.deepEqual(g.__actionSheet.options, ['Ask', 'Copy table', 'Copy', 'Select Text', 'Cancel']);
    // a shown cell that answers nothing (an empty cell, a gap): the table's menu after the wait
    g.__actionSheet = undefined;
    nativeGate.touch(true);
    await act(async () => gridHolder.__press.onLongPress());
    assert.equal(g.__actionSheet, undefined, 'not before the view has had its time');
    await act(async () => mock.timers.tick(MENU_WAIT));
    assert.deepEqual(g.__actionSheet.options, ['Ask', 'Copy table', 'Copy', 'Select Text', 'Cancel']);
    mock.timers.reset();
    g.__actionSheet = undefined;
    seen[2].onMenuAction({ nativeEvent: { id: 'ask', text: 'Pen' } });
    assert.deepEqual(asked, ['Pen']);
    // Select Table opens the table's own menu: Ask, Copy table, Copy, Select Text
    seen[2].onMenuAction({ nativeEvent: { id: 'selectTable' } });
    assert.deepEqual(g.__actionSheet.options, ['Ask', 'Copy table', 'Copy', 'Select Text', 'Cancel']);
    await act(async () => g.__actionSheet.pick(0));
    assert.deepEqual(asked, ['Pen', 'Item\tPrice\nPen\t3\nInk\t4']);
    await done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('with no composer a cell offers Select Cell and Select Table only; a cell’s own menu does nothing for an id it does not know', async () => {
  setInPlaceSelection(true);
  try {
    g.__nativeRuns = [];
    g.__actionSheet = undefined;
    const done = await mount(createElement(MessageBubble, { role: 'assistant', text: TABLE }));
    const seen = cells();
    assert.deepEqual(
      seen[0].menuEntries.map((e: any) => e.id),
      ['selectCell', 'selectTable'],
    );
    seen[0].onMenuAction({ nativeEvent: { id: 'selectCell' } });
    assert.equal(g.__actionSheet, undefined);
    await done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('with the in-place selection off a table has no native cells', async () => {
  g.__nativeRuns = [];
  const done = await mount(createElement(MessageBubble, { role: 'assistant', text: TABLE }));
  assert.equal(cells().length, 0);
  assert.ok(document.body.textContent?.includes('Pen'));
  await done();
});
