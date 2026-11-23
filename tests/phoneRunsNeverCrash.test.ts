// No native run may take the transcript down (#5368): every kind of block a reply can hand to a native text view, including the ones that come out with no styled run at all (an empty list item, an empty heading, an empty link, an empty table cell), is drawn, and never reads a style that is not there.
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
const runsPath = '../mobile/src/presentation/proseRuns';
const parsePath = '../shared/markdownParse.mjs';
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const markdownPath = '../mobile/src/components/Markdown';
const nativeRunPath = '../mobile/src/components/NativeRun';
const { Markdown } = await import(markdownPath);
const { NativeRun } = await import(nativeRunPath);
const { inRun, proseRuns, cellRuns } = await import(runsPath);
const { parseMarkdown } = await import(parsePath);

/** One reply for each kind of content the transcript can hand to a native run; the markers say what is expected to show. */
const KINDS: Record<string, [markdown: string, shows: string]> = {
  paragraph: ['plain words', 'plain words'],
  heading: ['## A heading', 'A heading'],
  'empty heading': ['#', ''],
  list: ['- one\n- two', 'one'],
  'empty list item': ['-', ''],
  'empty list items among words': ['- one\n-\n- three', 'three'],
  'empty ordered item': ['1.', ''],
  'nested list': ['- a\n  - b', 'b'],
  'list item with a second paragraph': ['- first\n\n  second', 'second'],
  'list item with code only': ['- `just code`', 'just code'],
  'task list': ['- [x] done\n- [ ] open', 'open'],
  'empty link': ['[](http://example.com)', ''],
  'link text': ['[words](http://example.com)', 'words'],
  'image only': ['![](x.png)', ''],
  'code only': ['`only code`', 'only code'],
  'soft break': ['one\ntwo', 'two'],
  'hard break': ['one  \ntwo', 'two'],
  deletion: ['~~gone~~', 'gone'],
  'url then CJK': ['https://example.com/a中文说明 之后', '之后'],
  'table with empty cells': ['| a | b |\n|---|---|\n| | x |\n| y | |', 'x'],
  'table with an empty header': ['| | b |\n|---|---|\n| 1 | 2 |', '2'],
  'table of empty cells': ['| |\n|---|\n| |', ''],
  'cell of only an image with no description': ['| ![](x.png) | b |\n|---|---|\n| 1 | 2 |', 'b'],
  'list item of only a nested list': ['- - nested', 'nested'],
  'nested lists three deep': ['- a\n  - b\n    - c', 'c'],
  'ordered list': ['3. three\n4. four', 'four'],
  'paragraph of only a hard break': ['\\\n', ''],
  'inline html': ['a <b>x</b> b', 'x'],
  'reference link': ['[words][r]\n\n[r]: http://example.com', 'words'],
  'reference image': ['![alt words][r]\n\n[r]: x.png', 'alt words'],
  footnote: ['a[^1]\n\n[^1]: the note', 'the note'],
  'table inside a list': ['- item\n\n  | a | |\n  |---|---|\n  | | b |', 'item'],
  'long CJK': [`${'中文说明'.repeat(60)}结束`, '结束'],
  'URL straight against CJK': ['https://example.com/a中文说明在这里', '这里'],
  'zero-length reply': ['', ''],
  'only spaces': ['   ', ''],
};

async function draw(markdown: string) {
  g.__nativeRuns = [];
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MessageBubble, { role: 'assistant', text: markdown })));
  const text = document.body.textContent ?? '';
  await act(async () => root.unmount());
  return text;
}

test('every kind of block a native run can be made of is drawn, and none of them takes the screen down', async () => {
  setInPlaceSelection(true);
  try {
    for (const [name, [markdown, shows]] of Object.entries(KINDS)) {
      const text = await draw(markdown).catch((error: Error) => assert.fail(`${name}: ${error.message}`));
      assert.ok(text.includes(shows), `${name}: ${JSON.stringify(text)}`);
    }
  } finally {
    setInPlaceSelection(false);
  }
});

test('a block with no styled run at all has no native view: it is drawn as the React text is, and the others are native as before', async () => {
  setInPlaceSelection(true);
  try {
    await draw('#');
    assert.equal(g.__nativeRuns.length, 0, 'an empty heading has nothing for a native view to lay out');
    await draw('plain words');
    assert.equal(g.__nativeRuns.length, 1);
    // an empty list item is its mark on a line (the React renderer draws that), so the view has that to lay out
    await draw('-');
    assert.deepEqual(
      g.__nativeRuns.map((p: any) => p.runs.map((r: any) => r.t).join('')),
      ['•\t'],
    );
    await draw('| a |\n|---|\n| |');
    // the filled cell is native; the empty one is not
    assert.deepEqual(
      g.__nativeRuns.map((p: any) => p.runs.map((r: any) => r.t).join('')),
      ['a'],
    );
  } finally {
    setInPlaceSelection(false);
  }
});

test('the run builders hand over what the view needs: a first run with a leading, or none at all (never a run without one)', () => {
  const colors = { ink: '#111', link: '#00f', codeBg: '#eee' };
  for (const [name, [markdown]] of Object.entries(KINDS)) {
    const blocks = ((parseMarkdown(markdown) as any).children as any[]).filter(inRun);
    if (!blocks.length) continue;
    const runs = proseRuns(blocks, colors, 1);
    for (const run of runs) assert.ok(Number(run.lh) > 0 && Number(run.fs) > 0, `${name}: ${JSON.stringify(run)}`);
    for (const block of blocks.filter((b: any) => b.type === 'table')) assert.ok(block);
  }
  const table = ((parseMarkdown('| a | |\n|---|---|\n| | b |') as any).children as any[])[0];
  for (const row of table.children)
    for (const cell of row.children)
      for (const run of cellRuns(cell, false, null, colors, 1)) assert.ok(Number(run.lh) > 0, 'a cell run has a leading');
});

test('the real Markdown component with the native view present draws every kind of block, empty ones included, with none throwing', async () => {
  setInPlaceSelection(true);
  try {
    for (const [name, [markdown, shows]] of Object.entries(KINDS)) {
      g.__nativeRuns = [];
      document.body.replaceChildren();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            createElement(Markdown, {
              text: markdown,
              serif: true,
              inPlace: { copyMessage: () => undefined, selectText: () => undefined },
            }),
          ),
        );
      } catch (error) {
        assert.fail(`${name}: ${(error as Error).message}`);
      }
      assert.ok((document.body.textContent ?? '').includes(shows), `${name}: ${JSON.stringify(document.body.textContent)}`);
      await act(async () => root.unmount());
    }
  } finally {
    setInPlaceSelection(false);
  }
});

test('NativeRun takes no runs, and runs with no words in them, and shows the React text for both; with words it is the native view', async () => {
  const draw = async (runs: any[]) => {
    g.__nativeRuns = [];
    document.body.replaceChildren();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(NativeRun, { runs, entries: [], onEntry: () => undefined, fallback: createElement('span', null, 'the react text') }),
      ),
    );
    const out = [document.body.innerHTML.includes('the react text'), g.__nativeRuns.length];
    await act(async () => root.unmount());
    return out;
  };
  assert.deepEqual(await draw([]), [true, 0]);
  assert.deepEqual(await draw([{ t: '', fs: '17', lh: '26', col: '#111', ps: '0' }]), [true, 0]);
  assert.deepEqual(
    await draw([
      { t: '', fs: '17', lh: '26', col: '#111', ps: '0' },
      { t: 'words', fs: '17', lh: '26', col: '#111', ps: '0' },
    ]),
    [true, 1],
  );
});

test('a numbered list with no start, and every shape above, give runs that all have a size and a leading (nothing for the native side to guess)', () => {
  const colors = { ink: '#111', link: '#00f', codeBg: '#eee' };
  const finite = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  const nodeOf = (markdown: string) => (parseMarkdown(markdown) as any).children as any[];
  const check = (name: string, runs: any[]) => {
    for (const run of runs) assert.ok(finite(run.fs) && finite(run.lh) && typeof run.t === 'string', `${name}: ${JSON.stringify(run)}`);
  };
  for (const [name, [markdown]] of Object.entries(KINDS)) {
    const blocks = nodeOf(markdown).filter(inRun);
    if (blocks.length) check(name, proseRuns(blocks, colors, 1.3));
    for (const table of nodeOf(markdown).filter((n: any) => n.type === 'table'))
      for (const row of table.children)
        for (const cell of row.children) check(`${name} cell`, cellRuns(cell, row === table.children[0], 'right', colors, 2));
  }
  // an ordered list a parser gave no start (null) is numbered from nothing, not dropped or thrown on
  const list = nodeOf('1. one\n2. two')[0];
  list.start = null;
  check('null start', proseRuns([list], colors, 1));
});
