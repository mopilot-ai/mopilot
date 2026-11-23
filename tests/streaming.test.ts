// Paced reveal of streamed replies (src/lib/textPacer.ts) and the word spans that fade in
// (src/lib/rehypeWords.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACE, TextPacer, fadeDelayMs, revealedPrefix, replyIsStreaming } from '../src/lib/textPacer.ts';
import { rehypeWords } from '../src/lib/rehypeWords.ts';

/** Run a pacer's steps from `from` ms as its timer would, until it has nothing to show; returns [ms, shown] per step. */
function steps(p: TextPacer, from = 0, cut?: (from: number, want: number) => number) {
  const out: [number, number][] = [];
  let now = from;
  for (let wait = p.step(now, cut); wait !== null && out.length < 1000; wait = p.step(now, cut)) {
    now += wait;
    out.push([now, p.shown]);
  }
  return out;
}

test('text after a pause waits one step; a small backlog shows after the longest step', () => {
  const p = new TextPacer(0);
  p.push(10);
  assert.equal(p.step(0), PACE.maxStepMs, 'the first step waits: that wait is the lag that evens out the next burst');
  assert.equal(p.shown, 0);
  assert.equal(p.step(PACE.maxStepMs), PACE.minStepMs);
  assert.equal(p.shown, 10);
  assert.equal(p.step(PACE.maxStepMs + PACE.minStepMs), null, 'nothing more to show: the next delta wakes it');
  assert.equal(p.done, true);
});

test('steps show about stepChars each, more often the larger the backlog', () => {
  const p = new TextPacer(0);
  p.push(1000);
  const run = steps(p);
  const shown = run.map(([, n]) => n).filter((n, i, a) => n > 0 && n !== a[i - 1]);
  const sizes = shown.map((n, i) => n - (shown[i - 1] ?? 0));
  assert.ok(
    sizes.slice(0, -1).every((s) => s >= PACE.stepChars),
    `sizes ${sizes}`,
  );
  // a backlog above what the fastest steps show in the target lag is caught up: early steps are larger
  assert.ok(sizes[0] > PACE.stepChars, `first step ${sizes[0]}`);
  assert.equal(p.shown, 1000);
  for (let i = 1; i < run.length; i++) assert.ok(run[i][0] - run[i - 1][0] <= PACE.maxStepMs, 'never waits longer than a step');
});

test('the reveal never goes backwards and never passes the text', () => {
  const p = new TextPacer(0);
  let last = 0;
  let now = 0;
  for (let i = 0; i < 40; i++, now += 100) {
    p.push((i + 1) * 37);
    p.step(now);
    assert.ok(p.shown >= last && p.shown <= (i + 1) * 37);
    last = p.shown;
  }
});

test('a steady stream is shown about the target lag behind it', () => {
  const p = new TextPacer(0);
  const lags: number[] = [];
  // 400 chars/s in 20-char deltas, the pacer stepping every 25 ms between them
  for (let t = 0, len = 0; t < 4000; t += 25) {
    if (t % 50 === 0) p.push((len += 20));
    p.step(t);
    if (t > 1500) lags.push(((p.target - p.shown) / 400) * 1000);
  }
  const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
  assert.ok(Math.abs(mean - PACE.targetLagMs) < PACE.targetLagMs * 0.3, `lag ${mean} ms`);
});

test('text already on screen stays shown, and a rewrite shorter than it shows only the rewrite', () => {
  const p = new TextPacer(500);
  p.push(520);
  assert.equal(p.shown, 500);
  steps(p);
  assert.equal(p.shown, 520);
  p.push(300);
  assert.equal(p.shown, 300);
  assert.equal(new TextPacer(50, 20).shown, 20);
});

test('a step that cannot end safely waits for more text, then goes on', () => {
  const p = new TextPacer(0);
  p.push(100);
  const held = (from: number) => from;
  // a backlog of 100 steps every 121 ms (550 ms × 22 / 100)
  assert.equal(p.step(0, held), 121);
  assert.equal(p.step(121, held), null);
  assert.equal(p.shown, 0);
  // the next text starts a new wait, then the step shows where the cut allows
  assert.equal(
    p.step(1000, (from, want) => from + Math.min(want, 5)),
    121,
  );
  assert.equal(
    p.step(1121, (from, want) => from + Math.min(want, 5)),
    PACE.minStepMs,
  );
  assert.equal(p.shown, 5);
});

test('a finished reply shows its backlog within about finishMs, a step every minStepMs, none of them large', () => {
  const p = new TextPacer(0);
  p.push(1000);
  p.step(0);
  p.finish();
  const run = steps(p, 1);
  assert.equal(p.shown, 1000);
  const shownAt = run.filter(([, n], i) => n !== (run[i - 1]?.[1] ?? 0));
  const last = shownAt.at(-1)![0];
  assert.ok(last <= PACE.finishMs + 2 * PACE.minStepMs, `all shown at ${last} ms`);
  const sizes = shownAt.map(([, n], i) => n - (shownAt[i - 1]?.[1] ?? 0));
  assert.ok(Math.max(...sizes) <= Math.ceil(1000 / (PACE.finishMs / PACE.minStepMs)), `sizes ${sizes}`);
  for (let i = 1; i < shownAt.length; i++) assert.ok(shownAt[i][0] - shownAt[i - 1][0] <= PACE.minStepMs + 1);
  // a short backlog finishes in steps of stepChars, sooner
  const q = new TextPacer(0);
  q.push(50);
  q.finish();
  const short = steps(q, 0)
    .map(([, n]) => n)
    .filter((n) => n > 0);
  assert.deepEqual([...new Set(short)], [22, 44, 50]);
  // a late correction after it finished is spread over finishMs of its own
  q.push(550);
  const late = [...new Set(steps(q, 1000).map(([, n]) => n))];
  assert.equal(late.at(-1), 550);
  assert.ok(late.length >= 20, `${late.length} steps`);
});

test('flushing shows everything and ends finishing; a later reply paces again', () => {
  const p = new TextPacer(0);
  p.push(100);
  p.finish();
  assert.equal(p.flush(), 100);
  assert.equal(p.done, true);
  p.push(200);
  assert.equal(p.step(0), 121, 'paces again from what was shown, with the usual wait');
  assert.equal(p.shown, 100);
});

test('a word fades in 2.5 ms per character after its step began, at most 150 ms', () => {
  assert.equal(fadeDelayMs(0), 0);
  assert.equal(fadeDelayMs(10), 25);
  assert.equal(fadeDelayMs(1000), 150);
});

test('prose advances without waiting for whitespace', () => {
  assert.equal(revealedPrefix('hello brave new world', 9), 'hello bra');
  assert.equal(revealedPrefix('hello brave new world', 11), 'hello brave');
  assert.equal(revealedPrefix('hello', 3), 'hel');
  assert.equal(revealedPrefix('hello', 99), 'hello');
  assert.equal(revealedPrefix('abc', 0), '');
});

const text = (value: string, start?: number, end?: number) => ({
  type: 'text',
  value,
  ...(start === undefined ? {} : { position: { start: { offset: start }, end: { offset: end } } }),
});
const words = (nodes: any[]) =>
  nodes.map((n: any) =>
    n.type === 'text'
      ? n.value
      : n.properties?.className?.[0] === 'fw'
        ? `[${n.children[0].value}|${n.properties.style ?? ''}]`
        : `<${n.tagName}>`,
  );

test('prose words become spans with their whitespace; code and math are left alone; no steps, no wait', () => {
  const tree: any = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', children: [text('Run the tests')] },
      {
        type: 'element',
        tagName: 'pre',
        children: [{ type: 'element', tagName: 'code', children: [text('npm test')] }],
      },
      { type: 'element', tagName: 'span', properties: { className: ['katex'] }, children: [text('x + y')] },
    ],
  };
  rehypeWords()(tree);
  assert.deepEqual(words(tree.children[0].children), ['[Run |]', '[the |]', '[tests|]']);
  assert.ok(tree.children[0].children.every((n: any) => n.properties.className[0] === 'fw'));
  assert.equal(tree.children[1].children[0].children[0].value, 'npm test');
  assert.equal(tree.children[2].children[0].value, 'x + y');
});

test("a step's words wait 2.5 ms a character after its start; a step splits CJK text where it began", () => {
  const tree: any = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        position: { start: { offset: 0 }, end: { offset: 19 } },
        children: [text('原因找到了主要不是渲染慢 and on', 0, 19)],
      },
    ],
  };
  // one step began before the run (at -4), the next at 5
  rehypeWords({ steps: [-4, 5] })(tree);
  assert.deepEqual(words(tree.children[0].children), [
    '[原因找到了|animation-delay:10ms]',
    '[主要不是渲染慢 |]',
    '[and |animation-delay:20ms]',
    '[on|animation-delay:30ms]',
  ]);
});

test('text without a position (line breaks) takes up where the node before it ended; escapes place steps proportionally', () => {
  const tree: any = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        children: [
          text('ab', 0, 2),
          { type: 'element', tagName: 'br', children: [] },
          text('\n'),
          text('cd'),
          { type: 'element', tagName: 'code', position: { start: { offset: 5 }, end: { offset: 9 } }, children: [text('x')] },
          // `a\*b` in the source is `a*b`: four source characters, three of text
          text(' a*b', 9, 14),
        ],
      },
    ],
  };
  rehypeWords({ steps: [0, 3, 11] })(tree);
  assert.deepEqual(words(tree.children[0].children), [
    '[ab|]',
    '<br>',
    '\n',
    '[cd|]',
    '<code>',
    '[ a|animation-delay:15ms]',
    '[*b|animation-delay:2.5ms]',
  ]);
});

test('a reply stops streaming when either its item or its turn ends', () => {
  assert.equal(replyIsStreaming(true), true);
  assert.equal(replyIsStreaming(true, 0), false, 'zero is a valid completion timestamp');
  assert.equal(replyIsStreaming(true, 1000), false);
  assert.equal(replyIsStreaming(false), false);
  assert.equal(replyIsStreaming(false, 1000), false);
});
