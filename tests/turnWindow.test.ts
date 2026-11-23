// The windowing math of a long thread: turn height estimates, the opening window, anchors and visible prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorCorrection,
  estimateTurnHeight,
  firstBelow,
  initialWindow,
  sameOrNext,
  turnPreview,
  visibleEntries,
  WINDOW_SCREENS,
} from '../src/lib/turnWindow.ts';

const turn = (items: any[]) => ({ id: 't', items, status: 'completed' }) as any;
const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }, { type: 'image' }] });

test('a turn is estimated from its prompt and reply lines, with a row for its work, and once per turn object', () => {
  // a prompt, one short line: the prompt's room plus a line
  assert.equal(estimateTurnHeight(turn([user('hi')])), 96 + 24);
  // a reply wraps at about 90 characters a line; a blank line is a paragraph gap; tool work folds into one row
  const reply = { type: 'agentMessage', text: `${'x'.repeat(181)}\n\nend` };
  assert.equal(estimateTurnHeight(turn([reply, { type: 'commandExecution' }])), 3 * 24 + 12 + 24 + 40);
  // a reply with no text, and content without text, still take a line at least
  assert.equal(estimateTurnHeight(turn([{ type: 'agentMessage' }, { type: 'userMessage' }])), 96 + 12 + 12);
  assert.equal(estimateTurnHeight(turn([{ type: 'userMessage', content: [{ type: 'text' }] }])), 96 + 12);
  assert.equal(estimateTurnHeight(turn([])), 24);
  // the same turn object is not measured again
  const once = turn([user('a')]);
  const first = estimateTurnHeight(once);
  once.items.push({ type: 'agentMessage', text: 'more' });
  assert.equal(estimateTurnHeight(once), first);
});

test('a chat opens on its last turns, enough to fill the budget, and always the last one', () => {
  const heights: Record<string, number> = { a: 300, b: 300, c: 300, d: 300 };
  const of = (id: string) => heights[id];
  assert.deepEqual([...initialWindow(['a', 'b', 'c', 'd'], of, 500)], ['d', 'c']);
  assert.deepEqual([...initialWindow(['a', 'b', 'c', 'd'], of, 601)], ['d', 'c', 'b']);
  // a single turn taller than the budget, or no budget at all, still renders the last turn
  assert.deepEqual([...initialWindow(['a', 'b'], of, 0)], ['b']);
  assert.deepEqual([...initialWindow([], of, 1000)], []);
  assert.equal(WINDOW_SCREENS, 2);
});

test('an unchanged window keeps its identity', () => {
  const previous = new Set(['a', 'b']);
  assert.equal(sameOrNext(previous, new Set(['b', 'a'])), previous);
  const grown = new Set(['a', 'b', 'c']);
  assert.equal(sameOrNext(previous, grown), grown);
  const other = new Set(['a', 'c']);
  assert.equal(sameOrNext(previous, other), other);
});

test('the first element below a line is found by bisection, reading few positions', () => {
  const bottoms = [100, 200, 300, 400, 500, 600, 700, 800];
  const read: number[] = [];
  const of = (i: number) => (read.push(i), bottoms[i]);
  assert.equal(firstBelow(bottoms.length, of, 350), 3);
  assert.ok(read.length <= 4, `read ${read.length} positions`);
  assert.equal(
    firstBelow(bottoms.length, (i) => bottoms[i], 0),
    0,
  );
  assert.equal(
    firstBelow(bottoms.length, (i) => bottoms[i], 800),
    bottoms.length,
  );
  assert.equal(
    firstBelow(0, () => 0, 10),
    0,
  );
});

test('an anchor that moved is scrolled back by as much; under a pixel is left alone', () => {
  assert.equal(anchorCorrection(120, 420), 300);
  assert.equal(anchorCorrection(120, -80), -200);
  assert.equal(anchorCorrection(120, 120.6), 0);
  assert.equal(anchorCorrection(120, 119.2), 0);
});

test('visible prompts: the entry above the top line and every prompt above the bottom', () => {
  // prompts 300px apart from 100; the viewport 100-300 scrolled by `s`; the transcript ends at 1900 - s
  const at = (s: number) => {
    const read: number[] = [];
    const tops = (i: number) => (read.push(i), 100 + i * 300 - s);
    const visible = visibleEntries(6, tops, { top: 100, bottom: 300, end: 1900 - s }, 16);
    return { visible, read: new Set(read).size };
  };
  // the end of entry 1 and the start of entry 2 are both on screen
  assert.deepEqual(at(450).visible, [1, 2]);
  // an entry whose last 16px or less is left at the top no longer counts
  assert.deepEqual(at(585).visible, [2]);
  assert.deepEqual(at(0).visible, [0]);
  // the first prompt is below the top line: nothing above it is an entry
  assert.deepEqual(
    visibleEntries(3, (i) => 200 + i * 300, { top: 100, bottom: 300, end: 1100 }, 16),
    [0],
  );
  // every prompt is above the line: the last entry runs to the transcript's end, while that is below the line
  assert.deepEqual(at(1700).visible, [5]);
  assert.deepEqual(
    visibleEntries(2, (i) => -500 + i * 10, { top: 100, bottom: 300, end: 110 }, 16),
    [],
  );
  assert.deepEqual(
    visibleEntries(0, () => 0, { top: 100, bottom: 300, end: 900 }, 16),
    [],
  );
  // a long thread reads a handful of prompts, not all of them
  const many = (i: number) => 100 + i * 300 - 30_000;
  let reads = 0;
  assert.deepEqual(
    visibleEntries(1000, (i) => (reads++, many(i)), { top: 100, bottom: 300, end: 1e6 }, 16),
    [100],
  );
  assert.ok(reads < 20, `read ${reads} prompts`);
});

test('a placeholder previews its prompt and the start of its last reply as plain text, once per turn object', () => {
  const t = turn([
    user('  Why is\n the app   slow?  '),
    { type: 'commandExecution' },
    { type: 'agentMessage', text: 'first' },
    { type: 'agentMessage', text: '## Done\n\nSee `foo` and **bar**.\n- one' },
  ]);
  // the first prompt and the last reply, with markup and runs of blank space flattened
  assert.deepEqual(turnPreview(t), { prompt: 'Why is the app slow?', reply: 'Done See foo and bar. one' });
  // text is clipped to what a placeholder can show, so a 20 kB reply costs the thread nothing
  const long = turnPreview(turn([user('p'.repeat(900)), { type: 'agentMessage', text: 'r'.repeat(20_000) }]));
  assert.equal(long.prompt.length, 240);
  assert.equal(long.reply.length, 600);
  // a turn with no prompt, no reply, only whitespace or no text at all previews what it has
  assert.deepEqual(turnPreview(turn([{ type: 'agentMessage', text: 'only' }])), { prompt: '', reply: 'only' });
  assert.deepEqual(turnPreview(turn([user('   '), { type: 'agentMessage' }, { type: 'userMessage' }])), { prompt: '', reply: '' });
  assert.deepEqual(turnPreview(turn([])), { prompt: '', reply: '' });
  // the same turn object is not read again
  const once = turn([user('a')]);
  const first = turnPreview(once);
  once.items.push({ type: 'agentMessage', text: 'more' });
  assert.equal(turnPreview(once), first);
});
