// A reply's prose as the styled runs of one native text view (#4837): which blocks can share a view, and the sizes, weights, spacing and indents of its runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../shared/markdownParse.mjs';
import { BLOCK_GAP, groupRuns, inRun, ITEM_GAP, LINE_BREAK, LIST_INDENT, proseRuns } from '../mobile/src/presentation/proseRuns';

const COLORS = { ink: '#111111', link: '#1864df', codeBg: '#eeeeee' };
const blocksOf = (markdown: string) => (parseMarkdown(markdown) as any).children as any[];
/** The runs of the first stretch of run blocks, as a reply's renderer hands them over. */
const runsOf = (markdown: string, scale = 1) => proseRuns(blocksOf(markdown).filter(inRun), COLORS, scale);
const text = (runs: { t: string }[]) => runs.map((r) => r.t).join('');

test('a paragraph is body text, each style a run of its own, with the marks it sits inside', () => {
  const runs = runsOf('Plain **bold *and italic*** and `code` with [a link](https://a.io) and ![alt words](x.png) end.');
  assert.equal(text(runs), 'Plain bold and italic and code with a link and alt words end.');
  const by = (t: string) => runs.find((r) => r.t === t)!;
  assert.deepEqual(by('bold ').b, '1');
  assert.equal(by('bold ').i, undefined);
  assert.deepEqual([by('and italic').b, by('and italic').i], ['1', '1']);
  assert.deepEqual([by('code').c, by('code').bg, by('code').b], ['1', '#eeeeee', undefined]);
  assert.equal(by('code').cs, '13', 'inline code is at the footnote size, as the React renderer draws it');
  assert.equal(by('Plain ').cs, undefined);
  assert.deepEqual([by('a link').u, by('a link').col], ['https://a.io', '#1864df']);
  assert.equal(by('Plain ').col, '#111111');
  for (const r of runs.filter((r) => !r.c)) assert.deepEqual([r.fs, r.lh], ['17', '26'], 'the reply’s body size and leading');
  // a line of inline code only is as tall as the code's own line height, as React Native draws it
  assert.deepEqual([by('code').fs, by('code').lh], ['17', '18'], 'inline code carries the footnote’s leading');
});

test('a paragraph after the first of a list item starts where the item’s text does', () => {
  const runs = runsOf('- first\n\n  second paragraph\n\n  `just code`');
  const lead = runs.find((r) => r.t === '•\t')!;
  const second = runs.find((r) => r.t === 'second paragraph')!;
  assert.equal(lead.fh, '0', 'the first paragraph’s first line holds the mark, one indent back');
  assert.equal(second.fh, second.hi, 'a later paragraph has no mark: its first line is at the item’s indent');
  const code = runs.find((r) => r.c)!;
  assert.equal(code.fh, code.hi);
});

test('the break after a paragraph of inline code only takes the height of that line, as the break after text takes the body’s', () => {
  const runs = runsOf('`only code`\n\nafter\n\nmore');
  const breaks = runs.filter((r) => r.t === '\n');
  assert.deepEqual(
    breaks.map((r) => r.lh),
    ['18', '26'],
  );
});

test('a line break before a line of inline code starts a paragraph of its own (the code line keeps its own height); the one it ends has no space after it, and an item’s second line sits where its text does', () => {
  // as React Native draws "text\n`code`": TextKit would take the code line's height from the text's first character if a separator joined them
  const runs = runsOf('text words\n`only code`');
  const broken = runs.find((r) => r.t === 'text words\n')!;
  assert.ok(broken, 'the break is a "\\n" there, not a line separator');
  assert.equal(broken.ps, '0', 'no space between the two lines');
  assert.equal(runs.find((r) => r.c === '1')!.ps, String(BLOCK_GAP), 'the space after the block comes after its last line');
  // the same break between two lines of the same height stays a separator (no second paragraph, no spacing)
  assert.equal(text(runsOf('one\ntwo words')), `one${LINE_BREAK}two words`);
  // in a list item: the mark leads the first paragraph, and the second starts at the item's text
  const item = runsOf('- item words\n`only code`');
  assert.deepEqual(
    item.map((r) => [r.t, r.ps, r.fh]),
    [
      ['•\t', '0', '0'],
      ['item words\n', '0', '0'],
      ['only code', String(BLOCK_GAP), '20'],
    ],
  );
  // a hard break before code is the same
  assert.equal(runsOf('one  \n`code`').find((r) => r.c === '1')!.ps, String(BLOCK_GAP));
  assert.ok(runsOf('one  \n`code`').some((r) => r.t.endsWith('\n') && r.ps === '0'));
});

test('an item with nothing in it is its mark alone on a line (it is not left out, which would pull the next item up)', () => {
  const runs = runsOf('- one\n-\n- three');
  assert.equal(text(runs), '•\tone\n•\t\n•\tthree');
  const empty = runs.filter((r) => r.t === '•\t')[1];
  assert.deepEqual([empty.lh, empty.ps], ['26', String(ITEM_GAP)]);
  // the last item of the last block has no break after it, as any last paragraph
  assert.equal(text(runsOf('- one\n-')), '•\tone\n•\t');
  // and inside a list that is not the last block, the list's gap follows it
  const inner = runsOf('- one\n-\n\nafter');
  assert.equal(inner.filter((r) => r.t === '•\t')[1].ps, String(BLOCK_GAP));
});

test('the size and leading follow the system text scale, as React Native scales both', () => {
  const [run] = runsOf('Words', 1.4);
  assert.deepEqual([run.fs, run.lh], [String(17 * 1.4), String(26 * 1.4)]);
});

test('a hard break is a line break inside the paragraph, an empty image reads as nothing, raw html as its text', () => {
  // a break inside a paragraph is a line separator (U+2028), which TextKit keeps in the paragraph: a "\n" would start a new one with its own spacing and first-line indent
  assert.equal(text(runsOf('one  \ntwo')), `one${LINE_BREAK}two`);
  assert.equal(text(runsOf('one\ntwo')), `one${LINE_BREAK}two`, 'a soft break reads the same');
  assert.equal(text(runsOf('a ![](x.png) b')), 'a  b');
  assert.equal(text(runsOf('a ![p][r] b\n\n[r]: x.png')), 'a p b', 'an image by reference reads as its description');
  assert.equal(text(runsOf('a <b>x</b> b')), 'a <b>x</b> b');
});

test('a deletion and a list inside the last item keep their text and their spacing', () => {
  assert.equal(text(runsOf('keep ~~gone~~ words')), 'keep gone words');
  // the React renderer draws a deletion struck through, so the native run marks it too, inside any other mark
  const struck = runsOf('keep ~~gone **and bold** [link](https://a.io)~~ words');
  assert.equal(struck.find((r) => r.t === 'gone ')!.d, '1');
  assert.deepEqual([struck.find((r) => r.t === 'and bold')!.d, struck.find((r) => r.t === 'and bold')!.b], ['1', '1']);
  assert.deepEqual([struck.find((r) => r.t === 'link')!.d, struck.find((r) => r.t === 'link')!.u], ['1', 'https://a.io']);
  assert.equal(struck.find((r) => r.t === 'keep ')!.d, undefined);
  assert.equal(struck.find((r) => r.t === ' words')!.d, undefined);
  // any other inline node (a reference link here) keeps the text it holds and the marks it sits inside, with no mark of its own
  const ref = runsOf('see **[the doc][r]** now\n\n[r]: https://a.io');
  assert.equal(text(ref), 'see the doc now');
  assert.deepEqual([ref.find((r) => r.t === 'the doc')!.b, ref.find((r) => r.t === 'the doc')!.u], ['1', undefined]);
  const runs = runsOf('- a\n  - nested last');
  assert.equal(text(runs), '•\ta\n•\tnested last');
  assert.equal(runs.find((r) => r.t === 'nested last')!.ps, String(BLOCK_GAP));
});

test('blocks are a gap apart: each paragraph but the last ends in a line break that carries the space after it', () => {
  const runs = runsOf('First.\n\nSecond.\n\nThird.');
  assert.equal(text(runs), 'First.\nSecond.\nThird.');
  const breaks = runs.filter((r) => r.t === '\n');
  assert.equal(breaks.length, 2);
  assert.ok(breaks.every((r) => r.ps === String(BLOCK_GAP)));
  assert.equal(runs.at(-1)!.t, 'Third.');
});

test('a heading is its own size and leading in semibold, then the gap', () => {
  const runs = runsOf('# Big\n\nBody\n\n### Small');
  const [big, , body, , small] = runs;
  assert.deepEqual([big.t, big.fs, big.lh, big.b], ['Big', '22', '28', '1']);
  assert.deepEqual([body.fs, body.b], ['17', undefined]);
  assert.deepEqual([small.fs, small.lh, small.b], ['17', '23', '1']);
});

test('a bullet list is items led by a bullet, indented, an item gap apart, then the block gap', () => {
  const runs = runsOf('- one\n- two\n- three\n\nAfter.');
  assert.equal(text(runs), '•\tone\n•\ttwo\n•\tthree\nAfter.');
  const hi = String(LIST_INDENT);
  const mark = runs.filter((r) => r.t === '•\t');
  assert.equal(mark.length, 3);
  assert.ok(mark.every((r) => r.hi === hi && r.fh === '0'));
  assert.deepEqual(
    runs.filter((r) => r.t === '\n').map((r) => r.ps),
    [String(ITEM_GAP), String(ITEM_GAP), String(BLOCK_GAP)],
  );
});

test('a list’s bullet and number are drawn in the mark colour when it is given, as React draws them softer than the text, and in the ink when not', () => {
  const marks = (colors: typeof COLORS & { mark?: string }, markdown: string) =>
    proseRuns(blocksOf(markdown).filter(inRun), colors, 1).filter((r) => r.t === '•\t' || r.t === '1.\t');
  const soft = { ...COLORS, mark: '#6c6b64' };
  for (const markdown of ['- one\n- two', '1. one\n\n   more words\n2. two', '- one\n\n  more words']) {
    assert.ok(marks(soft, markdown).length > 0);
    assert.ok(
      marks(soft, markdown).every((r) => r.col === '#6c6b64'),
      markdown,
    );
    assert.ok(
      marks(COLORS, markdown).every((r) => r.col === COLORS.ink),
      markdown,
    );
  }
  const words = proseRuns(blocksOf('- one').filter(inRun), soft, 1).find((r) => r.t === 'one')!;
  assert.equal(words.col, COLORS.ink, 'the words keep the ink');
});

test('a numbered list keeps its first number, and a list inside another is one level further in', () => {
  const runs = runsOf('3. three\n4. four\n   - nested\n5. five');
  assert.equal(text(runs), '3.\tthree\n4.\tfour\n•\tnested\n5.\tfive');
  const nested = runs.find((r) => r.t === 'nested')!;
  assert.deepEqual([nested.hi, nested.fh], [String(LIST_INDENT * 2), String(LIST_INDENT)]);
});

test('an item with several paragraphs and a nested list ends each with the right space, the last block of the run with none', () => {
  const runs = runsOf('- first para\n\n  second para\n  - child\n\nAfter\n\n- tail item');
  assert.equal(text(runs), '•\tfirst para\nsecond para\n•\tchild\nAfter\n•\ttail item');
  assert.equal(runs.at(-1)!.t, 'tail item');
});

test('what can share a view: paragraphs, headings and lists of paragraphs; a code block, a table, a quote, a rule, html and a list with code in it cannot', () => {
  const kinds = (markdown: string) => blocksOf(markdown).map(inRun);
  assert.deepEqual(kinds('p\n\n# h\n\n- a\n\n1. b'), [true, true, true, true]);
  assert.deepEqual(kinds('```\ncode\n```\n\n| a |\n|---|\n| 1 |\n\n> quote\n\n---\n\n<div>x</div>'), [false, false, false, false, false]);
  assert.deepEqual(kinds('- a\n  ```\n  code\n  ```'), [false]);
  assert.deepEqual(kinds('- a\n  - b\n    ```\n    code\n    ```'), [false]);
});

test('consecutive run blocks are grouped, and the others stand alone in between', () => {
  const blocks = blocksOf('one\n\n- two\n\n```\ncode\n```\n\nthree\n\n> quote\n\nfour');
  const groups = groupRuns(blocks);
  assert.deepEqual(
    groups.map((g) => ('run' in g ? `run ${g.run.length}` : (g.block as any).type)),
    ['run 2', 'code', 'run 1', 'blockquote', 'run 1'],
  );
  assert.deepEqual(groupRuns([]), []);
});
