// A streaming reply's Markdown: split at closed blocks, it renders what one parse renders, and re-parses only its tail.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, StrictMode } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, impl } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
const { remarkPlugins } = await import('../src/lib/markdownMath.ts');
/** The text of every run the view renders, in order. */
const parsed: string[] = [];
/** The text of every parse, splitting's and the view's, in order. */
const parses: string[] = [];
// before the view is imported, so splitting's parser counts its parses too
remarkPlugins.push(function (this: any) {
  const parse = this.parser;
  this.parser = (doc: string, file: unknown) => (parses.push(doc), parse(doc, file));
  return (_tree: unknown, file: { value: unknown }) => void parsed.push(String(file.value));
});
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { WORD_SPAN_LIMIT } = await import('../src/components/markdown/markdownRuns.ts');
const { closedBlocks, codeMayGrow } = await import('../src/lib/markdownBlocks.ts');

beforeEach(() => {
  resetStore();
  parsed.length = 0;
  parses.length = 0;
  // code stays the plain fallback in both renders compared
  impl['hl:highlight'] = () => new Promise(() => {});
});

// animated as an arrived reply is, streaming or not, so the comparison sees the same word spans
const md = (text: string, streaming: boolean) => h(Markdown, { text, cwd: '/repo', streaming, animate: true });

/** What one parse of `text` renders: a fresh view that never streamed. */
async function whole(text: string) {
  const v = await render(md(text, false));
  const html = v.$('.md')!.innerHTML;
  await v.unmount();
  return html;
}

/**
 * Stream `text` into one view, a few characters per frame, and check after every frame that the split view renders
 * exactly what one parse of the same text renders. Returns how many runs the finished text was split into.
 */
async function streamMatches(text: string, step = 1) {
  const v = await render(md('', true));
  for (let n = step; ; n = Math.min(n + step, text.length)) {
    const shown = text.slice(0, n);
    await v.rerender(md(shown, true));
    assert.equal(v.$('.md')!.innerHTML, await whole(shown), `after ${n} characters: ${JSON.stringify(shown)}`);
    if (n === text.length) break;
  }
  // a new folder renders every run again: one parse each
  parsed.length = 0;
  await v.rerender(h(Markdown, { text, cwd: '/elsewhere', streaming: true, animate: true }));
  await v.unmount();
  return parsed.length;
}

const FIXTURES: Record<string, string> = {
  fences: [
    'Intro paragraph.',
    '',
    '```ts',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '~~~~',
    'tilde',
    '',
    '```',
    'still in the tilde fence',
    '~~~~',
    '',
    '- item with a fence:',
    '  ```',
    '  inside',
    '',
    '  still inside',
    '  ```',
    '',
    'Done.',
  ].join('\n'),
  lists: [
    '1. first',
    '',
    '2. second, loose',
    '',
    '   continued',
    '',
    'Between lists.',
    '',
    '- a',
    '- b',
    '  - nested',
    '',
    '* other bullet',
    '',
    '10) ten',
    '11) eleven',
    '',
    'End.',
  ].join('\n'),
  tables: [
    'Before.',
    '',
    '| a | b |',
    '|---|:-:|',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'After the table.',
    '',
    'x | y',
    '--|--',
    '5 | 6',
    '',
  ].join('\n'),
  math: [
    'Inline $$x^2$$ math.',
    '',
    '$$',
    'a + b',
    '',
    '= c',
    '$$',
    '',
    '\\[',
    'e = mc^2',
    '\\]',
    '',
    'Text \\(y\\) after.',
    '',
    '$$ meta',
    'q',
    '$$',
    '',
    'Last.',
  ].join('\n'),
  blocks: [
    '# Heading',
    '',
    'Setext',
    '======',
    '',
    '> quote',
    'lazy',
    '',
    '> second quote',
    '',
    '    indented code',
    '',
    '    more code',
    '',
    '---',
    '',
    '<div>',
    '',
    'html then text',
    '',
    'Para one\nline two',
    '# interrupting heading',
    '',
    '**bold** and `code`.',
  ].join('\n'),
};

for (const [name, text] of Object.entries(FIXTURES))
  test(`streamed ${name} render what one parse renders at every length`, async () => {
    const runs = await streamMatches(text);
    assert.ok(runs > 2, `split into ${runs} runs`);
  });

test('a definition anywhere keeps the reply one parse: it applies to links above it', async () => {
  const text = 'See [docs][d] and note[^1].\n\nMore text.\n\nMore again.\n\n[d]: https://example.com/docs\n\n[^1]: The note.\n';
  assert.equal(await streamMatches(text), 1);
  // the definition arrives last: the runs above it become one parse without more text arriving
  const v = await render(md('See [docs][d].\n\nMore.\n\n', true));
  await v.rerender(md('See [docs][d].\n\nMore.\n\n[', true));
  await v.rerender(md('See [docs][d].\n\nMore.\n\n[d]: https://example.com/docs', true));
  assert.ok(v.$('a[href="https://example.com/docs"]'));
  await v.unmount();
});

test('closed blocks are not parsed again: each frame parses only the tail', async () => {
  const v = await render(md('First paragraph.\n\nSecond', true));
  await v.rerender(md('First paragraph.\n\nSecond', true));
  parsed.length = 0;
  await v.rerender(md('First paragraph.\n\nSecond one', true));
  // the first paragraph was cut off before its first render, so it is never parsed again
  assert.deepEqual(parsed, ['Second one']);
  parsed.length = 0;
  await v.rerender(md('First paragraph.\n\nSecond one grows', true));
  assert.deepEqual(parsed, ['Second one grows']);
  const first = v.$('.md p');
  // the reply finishes: it keeps its runs, so nothing on screen remounts, and renders as one parse would
  parsed.length = 0;
  await v.rerender(md('First paragraph.\n\nSecond one grows.', false));
  assert.deepEqual(parsed, ['Second one grows.']);
  assert.equal(v.$('.md p'), first);
  assert.equal(v.$('.md')!.innerHTML, await whole('First paragraph.\n\nSecond one grows.'));
  await v.unmount();
  // a reply that never streamed here (history) is one parse
  parsed.length = 0;
  await (await render(md('First paragraph.\n\nSecond one grows.', false))).unmount();
  assert.deepEqual(parsed, ['First paragraph.\n\nSecond one grows.']);
});

test('a streaming frame parses its tail once: the view renders the tree that splitting parsed', async () => {
  const head = '| a | b |\n|---|---|\n| 1 | 2 |';
  const v = await render(md(`Intro.\n\n${head}`, true));
  // the tail grows a frame at a time: one parse each, for splitting and the view together
  for (const rows of ['\n| 3', '\n| 3 | 4 |', '\n| 3 | 4 |\n| 5']) {
    parses.length = 0;
    await v.rerender(md(`Intro.\n\n${head}${rows}`, true));
    assert.deepEqual(parses, [`${head}${rows}`]);
  }
  const table = `${head}\n| 3 | 4 |\n| 5`;
  assert.equal(v.$('.md')!.innerHTML, await whole(`Intro.\n\n${table}`));
  // a frame that closes the tail parses the tail, then the run it closed and the new tail, each on its own
  parses.length = 0;
  const closing = `Intro.\n\n${table}\n\nAfter`;
  await v.rerender(md(closing, true));
  assert.deepEqual([...parses], [`${table}\n\nAfter`, `${table}\n\n`, 'After']);
  assert.equal(v.$('.md')!.innerHTML, await whole(closing));
  // that frame's tail parse went unused, and was let go once it rendered: a view of the same text parses its own
  parses.length = 0;
  const later = await render(md(`${table}\n\nAfter`, false));
  assert.deepEqual(parses, [`${table}\n\nAfter`]);
  await later.unmount();
  await v.unmount();
});

test('the tail parse is handed out once: a render done twice (Strict Mode) parses its own tree the second time', async () => {
  const strict = (text: string) => h(StrictMode, null, md(text, true));
  const v = await render(strict('Intro.\n\nOne'));
  parses.length = 0;
  await v.rerender(strict('Intro.\n\nOne two'));
  // splitting parses twice (the reply renders twice); the view takes the second parse once, then parses its own
  assert.deepEqual(parses, ['One two', 'One two', 'One two']);
  assert.equal(v.$('.md')!.innerHTML, await whole('Intro.\n\nOne two'));
  await v.unmount();
});

test('a run that outgrows the word-span limit renders its words plain from then on, and the runs after it do not', async () => {
  const long = `${'word '.repeat(WORD_SPAN_LIMIT / 5)}end`;
  const v = await render(md('Intro.\n\nShort', true));
  assert.equal(v.$$('.md .fw').length, 2);
  await v.rerender(md(`Intro.\n\n${long}`, true));
  // the long run has no spans; the closed run above keeps its own
  assert.equal(v.$$('.md .fw').length, 1);
  assert.ok(v.$$('.md p')[1].textContent!.endsWith('end'));
  // re-paced to less text, back under the limit, it stays plain: spans back would fade it all in again
  await v.rerender(md('Intro.\n\nword word', true));
  assert.equal(v.$$('.md .fw').length, 1);
  await v.rerender(md(`Intro.\n\n${long}`, true));
  // cut off by the next block, the long run stays plain; the new run has spans
  await v.rerender(md(`Intro.\n\n${long}\n\nNext words`, true));
  assert.equal(v.$$('.md .fw').length, 3);
  assert.equal(v.$$('.md p')[1].querySelector('.fw'), null);
  // finished, it stays as it streamed
  await v.rerender(md(`Intro.\n\n${long}\n\nNext words`, false));
  assert.equal(v.$$('.md .fw').length, 3);
  // a rewrite starts again: its runs have spans until they outgrow the limit
  await v.rerender(md('Rewritten.\n\nShort', true));
  assert.equal(v.$$('.md .fw').length, 2);
  await v.unmount();
  // a late rewrite below a plain run splits the reply again; the plain run, unchanged, keeps its DOM and stays plain
  const m = await render(md(`Intro.\n\n${long}`, true));
  await m.rerender(md(`Intro.\n\n${long}\n\n\\[\na\n\nb`, true));
  const plain = m.$$('.md p')[1];
  assert.equal(plain.querySelector('.fw'), null);
  await m.rerender(md(`Intro.\n\n${long}\n\n\\[\na\n\nb\n\\]`, true));
  assert.equal(m.$$('.md p')[1], plain);
  assert.equal(plain.querySelector('.fw'), null);
  await m.unmount();
  // a reply that never streamed here keeps its spans however long it is
  const history = await render(md(long, false));
  assert.equal(history.$$('.md .fw').length, WORD_SPAN_LIMIT / 5 + 1);
  await history.unmount();
});

test('a block keeps its DOM from its first word: it starts in its own run and never moves', async () => {
  const v = await render(md('Intro.\n\n- it', true));
  await v.rerender(md('Intro.\n\n- ite', true));
  const item = v.$('.md li');
  for (const text of [
    'Intro.\n\n- item one',
    'Intro.\n\n- item one\n',
    'Intro.\n\n- item one\n- two',
    'Intro.\n\n- item one\n- two\n\nAfter.',
  ])
    await v.rerender(md(text, true));
  assert.equal(v.$('.md li'), item);
  assert.equal(v.$('.md')!.innerHTML, await whole('Intro.\n\n- item one\n- two\n\nAfter.'));
  await v.unmount();
});

test('text that no longer extends what was split starts again, split from the rewritten text', async () => {
  const v = await render(md('Alpha.\n\nBeta.\n\nGam', true));
  await v.rerender(md('Alpha.\n\nBeta.\n\nGam', true));
  parsed.length = 0;
  await v.rerender(md('Rewritten.\n\nBeta.\n\nGamma', true));
  assert.deepEqual(parsed, ['Rewritten.\n\n', 'Beta.\n\n', 'Gamma']);
  assert.equal(v.$('.md')!.innerHTML, await whole('Rewritten.\n\nBeta.\n\nGamma'));
  // a late `\]` rewrites the math above it; the paragraph before it was cut off already, so only the math re-parses
  await v.rerender(md('Intro.\n\n\\[\na\n\nb', true));
  await v.rerender(md('Intro.\n\n\\[\na\n\nb', true));
  parsed.length = 0;
  await v.rerender(md('Intro.\n\n\\[\na\n\nb\n\\]', true));
  assert.equal(parsed[0], '$$\na\n\nb\n$$');
  assert.equal(v.$('.md')!.innerHTML, await whole('Intro.\n\n\\[\na\n\nb\n\\]'));
  await v.unmount();
});

test('a block counts as closed once its first line is complete, or at once after a blank line', () => {
  const at = (start: number, end: number) => ({ type: 'paragraph', position: { start: { offset: start }, end: { offset: end } } });
  // "a\n\nb": b follows a blank line and cannot continue a: closed at once
  assert.deepEqual(closedBlocks('a\n\nb', { type: 'root', children: [at(0, 1), at(3, 4)] }), [3]);
  // after a list, "2" could become "2." and continue it: wait for its line
  const list = (start: number, end: number) => ({ ...at(start, end), type: 'list' });
  assert.deepEqual(closedBlocks('- a\n\n2', { type: 'root', children: [list(0, 3), at(5, 6)] }), []);
  assert.deepEqual(closedBlocks('- a\n\n2.\n', { type: 'root', children: [list(0, 3), at(5, 7)] }), [5]);
  // after a list, a line that cannot continue it is closed at once
  assert.deepEqual(closedBlocks('- a\n\nb', { type: 'root', children: [list(0, 3), at(5, 6)] }), [5]);
  // after a paragraph nothing can continue it: a list starting there is closed at once, so it never moves runs
  assert.deepEqual(closedBlocks('a\n\n- b', { type: 'root', children: [at(0, 1), at(3, 6)] }), [3]);
  // a block that interrupts the one above without a blank line waits for its line too
  assert.deepEqual(closedBlocks('a\n# h', { type: 'root', children: [at(0, 1), at(2, 5)] }), []);
  // a tree without positions or children yields no boundary
  assert.deepEqual(closedBlocks('a\n\nb\n', { type: 'root', children: [{ type: 'paragraph' }, { type: 'paragraph' }] }), []);
  assert.deepEqual(closedBlocks('', { type: 'root' }), []);
  // definitions, at any depth, need the whole text
  assert.equal(closedBlocks('', { type: 'root', children: [{ type: 'blockquote', children: [{ type: 'definition' }] }] }), null);
});

test('a code block at the end of a growing run can grow until its closing fence arrives', () => {
  const at = (start?: number, end?: number) => ({ start: { offset: start }, end: { offset: end } });
  const grows = (text: string, start = 0, end = text.trimEnd().length) => codeMayGrow(text, at(start, end));
  // text after the block (beyond blank lines) closed it; a block without offsets cannot be placed
  assert.equal(codeMayGrow('```\na\n```\n\nb', at(0, 9)), false);
  assert.equal(codeMayGrow('```\na', undefined), false);
  assert.equal(codeMayGrow('```\na', at(0)), false);
  assert.equal(grows('```\na\n\n'), true);
  // a fence that so far is only its opening line, or a line of code, still grows; indented code always may
  assert.equal(grows('```js'), true);
  assert.equal(grows('```js\na'), true);
  assert.equal(grows('    code\n    more'), true);
  assert.equal(grows('Intro.\n\n    code\n    ```', 8), true);
  // a closing fence of the same character, at least as long, closes it, also inside a quote or a list item
  assert.equal(grows('```js\na\n```'), false);
  assert.equal(grows('```\na\n`````  '), false);
  assert.equal(grows('> ~~~\n> a\n> ~~~', 2), false);
  assert.equal(grows('- x\n  ```\n  a\n  ```', 6), false);
  // a shorter run, the other character or text after the backticks does not
  assert.equal(grows('````\na\n```'), true);
  assert.equal(grows('~~~\na\n```'), true);
  assert.equal(grows('```\na\n```x'), true);
});

test('blocks that arrive together in one delta keep their DOM when the reply goes on (#1221)', async () => {
  // a background window shows a delta at once, and batched deltas join several blocks: the first render already has them
  const first =
    '| Name | Value |\n| --- | --- |\n| First | One |\n\n[the docs](https://example.com)\n\n```js\nconst first = 1;\n```\n\nExisting words stay visible ';
  const v = await render(md(first, true));
  const nodes = ['table', 'a', 'pre', 'p:last-of-type'].map((s) => v.$(`.md ${s}`));
  assert.ok(nodes.every(Boolean));
  const text = first + 'when more words arrive. '.repeat(3);
  await v.rerender(md(text, true));
  assert.deepEqual(
    nodes.map((n) => n!.isConnected),
    [true, true, true, true],
  );
  assert.equal(v.$('.md')!.innerHTML, await whole(text));
  await v.unmount();
});

/**
 * A paragraph after a list is parsed before its boundary can be declared: while its first line is incomplete it
 * could still turn into a list item (`closedBlocks`'s MAY_CONTINUE), so it renders inside the run above it.
 * Cutting there once the line completes would move a block that is already on screen into a run of its own.
 */
test('a block rendered before its boundary was known keeps its DOM once the boundary appears', async () => {
  const v = await render(md('- item\n\n2x', true));
  const item = v.$('.md li');
  const after = [...v.$('.md')!.querySelectorAll('p')].find((e) => e.textContent?.includes('2x'));
  assert.ok(item && after, `li=${!!item} p=${!!after}`);
  for (const text of ['- item\n\n2x\n', '- item\n\n2x and more\n', '- item\n\n2x and more\n\nAfter.']) await v.rerender(md(text, true));
  assert.equal(item!.isConnected, true, 'the list item remounted');
  assert.equal(after!.isConnected, true, 'the paragraph remounted once its boundary appeared');
  assert.equal(v.$('.md')!.innerHTML, await whole('- item\n\n2x and more\n\nAfter.'));
  await v.unmount();
});

/**
 * Stream `chunks` one per render, as an unpaced window does, and check that every element a chunk rendered is
 * still in the document after the later chunks. Each chunk ends a top-level block, so nothing in it can be
 * re-parsed into something else and a surviving node is the only correct outcome. This generalizes the delta
 * above over the block kinds and chunk shapes a reply can arrive in.
 */
async function chunksKeepTheirNodes(chunks: string[]) {
  const v = await render(md('', true));
  let text = '';
  const rendered: { chunk: number; el: Element }[] = [];
  for (const [index, chunk] of chunks.entries()) {
    text += chunk;
    await v.rerender(md(text, true));
    for (const { chunk: from, el } of rendered)
      assert.ok(el.isConnected, `a ${el.nodeName.toLowerCase()} from chunk ${from} remounted when chunk ${index} arrived`);
    for (const el of v.$('.md')!.querySelectorAll('*')) if (!rendered.some((r) => r.el === el)) rendered.push({ chunk: index, el });
  }
  assert.equal(v.$('.md')!.innerHTML, await whole(text));
  await v.unmount();
  return rendered.length;
}

const CHUNKED: Record<string, string[]> = {
  // a block of each kind in one chunk, then text that grows the last paragraph
  'blocks of every kind': [
    '# Heading\n\nA paragraph with [a link](https://example.com) and `code`.\n\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\n> quote\n\n```ts\nconst a = 1;\n```\n\nLast paragraph ',
    'that grows.',
  ],
  // one block per chunk: every chunk both closes a block and opens the next
  'one block per chunk': ['First.\n\n', '- item\n\n', '```\nfenced\n```\n\n', 'Tail '],
};

for (const [name, chunks] of Object.entries(CHUNKED))
  test(`${name} keeps every node it rendered when the next chunk arrives`, async () => {
    assert.ok((await chunksKeepTheirNodes(chunks)) > 5);
  });
