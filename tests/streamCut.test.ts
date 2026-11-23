// Where a streaming reply's paced text may end (src/lib/streamCut.ts): never inside Markdown that renders differently once it closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOLD, openConstruct, revealCeiling, safeEnd, settledText, stepEnd } from '../src/lib/streamCut.ts';

/** Where the reveal may stop when `text` has arrived and the step wants to end at `‸` (removed from the text). */
function cutAt(marked: string, from = 0) {
  const at = marked.indexOf('‸');
  const text = marked.slice(0, at) + marked.slice(at + 1);
  return text.slice(0, safeEnd(text, from, at));
}

test('inline constructs hold back to where they opened until they close', () => {
  assert.equal(cutAt('The cause is **not ren‸dering** at all.'), 'The cause is ');
  assert.equal(cutAt('The cause is **not rendering**‸ at all.'), 'The cause is **not rendering**');
  assert.equal(cutAt('it is the `pac‸ing` policy'), 'it is the ');
  assert.equal(cutAt('see [the do‸cs](https://x.y) now'), 'see ');
  assert.equal(cutAt('see [the docs](https://x‸.y) now'), 'see ');
  assert.equal(cutAt('see [the docs]‸(https://x.y) now'), 'see ', 'a closed label may still become a link');
  assert.equal(cutAt('see [1] and‸ more'), 'see [1] and', 'a bracket not followed by a link is text');
  assert.equal(cutAt('![alt‸](a.png)'), '');
  assert.equal(cutAt('math $$x^‸2$$ here'), 'math ');
  assert.equal(cutAt('math \\(x^‸2\\) here'), 'math ');
  assert.equal(cutAt('math \\[x^‸2\\] here'), 'math ');
  assert.equal(cutAt('math \\(x\\) and \\[y\\] then wo‸rds'), 'math \\(x\\) and \\[y\\] then ', 'closed math is passed over');
  assert.equal(cutAt('a <https://x‸.y> b'), 'a ');
  assert.equal(cutAt('a ~~gone‸~~ b'), 'a ');
  assert.equal(cutAt('a _it‸_ b'), 'a ');
  assert.equal(cutAt('snake_case_name‸ ok'), 'snake_case_name', 'an underscore inside a word opens nothing');
  assert.equal(cutAt('2 * 3 is‸ six'), '2 * 3 is', 'an asterisk between spaces opens nothing');
  assert.equal(cutAt('Tom &am‸p; Jerry'), 'Tom ');
  assert.equal(cutAt('a back\\‸'), 'a ');
  assert.equal(cutAt('escaped \\*not‸ bold'), 'escaped \\*not');
  assert.equal(cutAt('cite :codex-file-citation{path="/a‸"} ok'), 'cite ');
  assert.equal(cutAt('viz \uE200visualize\uE202{"pa‸th":1}\uE201'), 'viz ');
  assert.equal(cutAt('**‸'), '', 'a run at the end may still open');
  assert.equal(cutAt('cost $‸'), 'cost ', 'a dollar may still become $$ math');
  assert.equal(cutAt('see !‸'), 'see ', 'it may become an image');
  assert.equal(cutAt('a :cod‸'), 'a ', 'it may become a directive');
  assert.equal(cutAt('Steps:‸\n'), 'Steps:', 'a complete line keeps its colon');
});

test('a cut inside a word moves back to its start, not further than WORD_SNAP; CJK text cuts anywhere', () => {
  assert.equal(cutAt('hello wor‸ld'), 'hello ');
  assert.equal(cutAt('hello world‸'), 'hello ', 'the last word that arrived may not be whole');
  assert.equal(cutAt('hello world‸ '), 'hello world');
  assert.equal(cutAt('see h‸'), 'see ', 'it may become a link');
  assert.equal(cutAt('a supercalifragilisticexpialido‸cious'), 'a supercalifragilisticexpialido');
  assert.equal(cutAt('原因找到了主要‸不是渲染慢'), '原因找到了主要');
  assert.equal(cutAt('hello wor‸ld', 8), 'hello wo', 'never back past where the step began');
  assert.equal(cutAt('Footn‸ote here'), '', 'the first word of a line waits to be whole too');
  assert.equal(cutAt('MoPilot 卡‸顿了'), 'MoPilot 卡', 'a CJK word cuts anywhere');
  assert.equal(cutAt('Use `` co ` de ``‸ more'), 'Use `` co ` de ``');
  assert.equal(cutAt('Use `` co ` de ``‸'), 'Use ', 'a snapped cut that would reopen a construct goes before it');
  assert.equal(cutAt('😀‸ 😀'), '😀');
  // a cut splitting a surrogate pair moves before it
  assert.equal(safeEnd('a 😀', 0, 3), 2);
  assert.equal(safeEnd('```\n😀', 0, 5), 4, 'in code too');
});

test('lines that may still become a block marker, a fence or a rule wait until they are complete', () => {
  assert.equal(cutAt('Intro.\n\n1‸'), 'Intro.\n\n');
  assert.equal(cutAt('Intro.\n\n1.‸'), 'Intro.\n\n');
  assert.equal(cutAt('Intro.\n\n1. fi‸rst'), 'Intro.\n\n', 'a marker waits for its first word');
  assert.equal(cutAt('Intro.\n\n1. first wo‸rd'), 'Intro.\n\n1. first ');
  assert.equal(cutAt('1. item\n   - ne‸sted'), '1. item\n', '`- ` alone under text would be a setext underline');
  assert.equal(cutAt('Intro.\n\n1. first\n2‸'), 'Intro.\n\n1. first\n');
  assert.equal(cutAt('## ‸Heading'), '');
  assert.equal(cutAt('> ‸quote'), '');
  assert.equal(cutAt('- [‸x] done'), '');
  assert.equal(cutAt('- **bo‸ld** item'), '', 'a construct right after the markers holds them too');
  assert.equal(cutAt('Text\n---‸'), 'Text\n');
  assert.equal(cutAt('Text\n\n```p‸y\ncode'), 'Text\n\n');
  assert.equal(cutAt('Text\n\n```py‸\ncode'), 'Text\n\n```py', 'a complete fence line shows');
  assert.equal(cutAt('Text\n\n``‸'), 'Text\n\n');
});

test('code inside a fence shows as it grows, except a line that may close it; $$ math waits for its close', () => {
  assert.equal(cutAt('```js\nconst x = **no‸t bold\n'), '```js\nconst x = **no');
  assert.equal(cutAt('```js\nx\n``‸'), '```js\nx\n');
  assert.equal(cutAt('```js\nx\n```‸\nafter'), '```js\nx\n```');
  assert.equal(cutAt('~~~\nx\n~~~\n\nafter **b‸old**'), '~~~\nx\n~~~\n\nafter ');
  assert.equal(cutAt('Intro\n\n$$\nx^‸2\n$$\nafter'), 'Intro\n\n');
  assert.equal(cutAt('Intro\n\n$$\nx^2\n$$\nafter‸ text'), 'Intro\n\n$$\nx^2\n$$\nafter');
  assert.equal(cutAt('Intro\n\n$$x^2$$\nafter‸ text'), 'Intro\n\n$$x^2$$\nafter', 'one-line $$ math is no block');
});

test('a cut at the start of a line ends the line before it, which decides', () => {
  assert.equal(cutAt('Intro **bold\n‸'), 'Intro ');
  assert.equal(cutAt('| a | b |\n‸|-'), '', 'a header row waits for its delimiter line');
  assert.equal(cutAt('| a | b |\n|--|--|\n‸| 1 | 2 |'), '| a | b |\n|--|--|\n');
  assert.equal(cutAt('Run cat log | grep error now.\n‸More'), 'Run cat log | grep error now.\n', 'a pipe in prose holds nothing');
  assert.equal(cutAt('plain\n‸more'), 'plain\n');
});

test('which block a line is in is read from each text as it is, however the texts alternate', () => {
  const code = '```\na **b';
  const prose = 'x\na **b';
  assert.equal(safeEnd(code, 0, code.length), code.length, 'inside a fence, code shows as it grows');
  assert.equal(safeEnd(prose, 0, prose.length), 4);
  assert.equal(safeEnd(code, 0, code.length), code.length);
});

test('a table shows once its delimiter line is in, then row by row', () => {
  assert.equal(cutAt('Before.\n\n| a | b |\n|-‸'), 'Before.\n\n');
  assert.equal(cutAt('Before.\n\n| a | b |\n|---|---|‸'), 'Before.\n\n', 'the delimiter line is not complete yet');
  assert.equal(cutAt('Before.\n\n| a | b |\n|---|---|‸\n| 1'), 'Before.\n\n| a | b |\n|---|---|');
  assert.equal(cutAt('| a | b |\n|---|---|\n| 1 | tw‸o |'), '| a | b |\n|---|---|\n| 1 | ');
  assert.equal(cutAt('| a | b |‸'), '');
});

test('the ceiling holds at most MAX_HOLD characters; a finished reply shows everything', () => {
  const open = `Start **${'x'.repeat(MAX_HOLD + 100)}`;
  assert.equal(revealCeiling(open), open.length - MAX_HOLD);
  assert.equal(revealCeiling('Start **bold'), 'Start '.length);
  assert.equal(revealCeiling('Start **bold', true), 'Start **bold'.length);
  assert.equal(revealCeiling(''), 0);
});

test('a step steps past what cannot end yet to the first safe point, up to the ceiling', () => {
  const text = 'One **two three four five six seven** eight nine ten eleven';
  // 22 characters from 0 end inside the bold: the step shows what is before it
  assert.equal(stepEnd(text, 0, 22, text.length), 4);
  // from there nothing ends before the bold closes: the step goes on past its close
  const end = stepEnd(text, 4, 22, text.length);
  assert.ok(end >= text.indexOf('** eight') + 2, `ended at ${end}`);
  assert.equal(stepEnd(text, 4, 22, 4), 4);
  // nothing safe before the ceiling (a construct that never closes): steps of `want`, up to the ceiling
  assert.equal(stepEnd('**abc', 0, 2, 3), 2);
  assert.equal(stepEnd('**abc', 2, 2, 3), 3);
  const unclosed = `Use **bold ${'word '.repeat(40)}`;
  assert.equal(stepEnd(unclosed, 4, 22, unclosed.length), 26, 'a finished reply with a stray ** still shows in steps');
});

test('text shown without pacing stops where nothing shown changes form, until it is finished', () => {
  assert.equal(settledText('Checking **the pac', true), 'Checking ');
  assert.equal(settledText('Checking the pac', true), 'Checking the pac', 'its last word shows as it arrives');
  assert.equal(revealCeiling('Checking the pac'), 'Checking the '.length, 'a paced reply waits for the word');
  assert.equal(settledText('Checking **the pac', false), 'Checking **the pac');
});

test('openConstruct finds the earliest open construct, or -1', () => {
  assert.equal(openConstruct('plain text'), -1);
  assert.equal(openConstruct('a `b` **c'), 6);
  assert.equal(openConstruct('a [b](c) `d'), 9);
  assert.equal(openConstruct('**a `b'), 0);
  assert.equal(openConstruct('a < b'), -1);
  assert.equal(openConstruct('a <'), 2);
  assert.equal(openConstruct('x *', 0), 2);
});
