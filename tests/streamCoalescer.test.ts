// The frame coalescer (src/lib/streamNotifications.ts) joins a text or thinking delta with any pending
// delta of the same key, so chats and items streaming at once cost one update per key per frame
// (#1208 phase 0), while order across non-delta events and every item's final text stay unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamNotifications } from '../src/lib/streamNotifications.ts';

const TEXT = 'item/agentMessage/delta';
const THINK = 'item/reasoning/summaryTextDelta';
const delta = (threadId: string, itemId: string, delta: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  turnId: `${threadId}-u`,
  itemId,
  delta,
  ...extra,
});

/** A coalescer whose paint the test runs by hand, recording every delivered notification. */
function coalescer() {
  const out: [string, any][] = [];
  const paints: (() => void)[] = [];
  const d = createStreamNotifications(
    (m, p) => out.push([m, p]),
    (paint) => {
      paints.push(paint);
      return () => {};
    },
  );
  return { d, out, paint: () => paints.splice(0).forEach((p) => p()) };
}

test('two chats interleaved A/B/A/B deliver once per key per frame, in first-arrival order', () => {
  const { d, out, paint } = coalescer();
  d.emit(TEXT, delta('A', 'a1', 'Hel'));
  d.emit(TEXT, delta('B', 'b1', 'Good'));
  d.emit(TEXT, delta('A', 'a1', 'lo'));
  d.emit(TEXT, delta('B', 'b1', 'bye'));
  assert.deepEqual(out, []);
  paint();
  assert.deepEqual(out, [
    [TEXT, delta('A', 'a1', 'Hello')],
    [TEXT, delta('B', 'b1', 'Goodbye')],
  ]);
  // the next frame starts a new batch
  d.emit(TEXT, delta('B', 'b1', '!'));
  d.emit(TEXT, delta('A', 'a1', '?'));
  paint();
  assert.deepEqual(out.slice(2), [
    [TEXT, delta('B', 'b1', '!')],
    [TEXT, delta('A', 'a1', '?')],
  ]);
});

test('two items of one chat interleaved are joined per item, text and thinking apart', () => {
  const { d, out, paint } = coalescer();
  d.emit(THINK, delta('A', 'r1', 'think', { summaryIndex: 0 }));
  d.emit(TEXT, delta('A', 'm1', 'ans'));
  d.emit(THINK, delta('A', 'r1', 'ing', { summaryIndex: 0 }));
  d.emit(TEXT, delta('A', 'm1', 'wer'));
  d.emit(THINK, delta('A', 'r1', ' more', { summaryIndex: 1 })); // another summary part
  paint();
  assert.deepEqual(out, [
    [THINK, delta('A', 'r1', 'thinking', { summaryIndex: 0 })],
    [TEXT, delta('A', 'm1', 'answer')],
    [THINK, delta('A', 'r1', ' more', { summaryIndex: 1 })],
  ]);
});

test('a non-delta event between deltas flushes everything pending first and keeps the order', () => {
  const { d, out, paint } = coalescer();
  d.emit(TEXT, delta('A', 'a1', 'one'));
  d.emit(TEXT, delta('B', 'b1', 'two'));
  d.emit(TEXT, delta('A', 'a1', ' three'));
  d.emit('item/completed', { threadId: 'A', item: { id: 'a1' } });
  d.emit(TEXT, delta('A', 'a1', ' four')); // after the event: not joined with what came before it
  d.emit(TEXT, delta('B', 'b1', ' five'));
  paint();
  assert.deepEqual(out, [
    [TEXT, delta('A', 'a1', 'one three')],
    [TEXT, delta('B', 'b1', 'two')],
    ['item/completed', { threadId: 'A', item: { id: 'a1' } }],
    [TEXT, delta('A', 'a1', ' four')],
    [TEXT, delta('B', 'b1', ' five')],
  ]);
});

test('a delta whose extra field differs from every pending one is not joined', () => {
  const { d, out, paint } = coalescer();
  d.emit(TEXT, delta('A', 'a1', 'x', { segment: 1 }));
  d.emit(TEXT, delta('B', 'b1', 'y'));
  d.emit(TEXT, delta('A', 'a1', 'z', { segment: 2 })); // same item, another segment
  d.emit(TEXT, delta('A', 'a1', 'w')); // same item, one field fewer
  d.emit(TEXT, delta('A', 'a1', 'v', { segment: 1 })); // joins the first, past two others
  paint();
  assert.deepEqual(out, [
    [TEXT, delta('A', 'a1', 'xv', { segment: 1 })],
    [TEXT, delta('B', 'b1', 'y')],
    [TEXT, delta('A', 'a1', 'z', { segment: 2 })],
    [TEXT, delta('A', 'a1', 'w')],
  ]);
});

test('200 interleaved chunks across two chats deliver 2 times with every final text intact', () => {
  const { d, out, paint } = coalescer();
  const want = { A: '', B: '' };
  for (let i = 0; i < 200; i++) {
    const chat = i % 2 ? 'B' : 'A';
    const chunk = `${chat}${i};`;
    want[chat] += chunk;
    d.emit(TEXT, delta(chat, `${chat}-m`, chunk));
  }
  paint();
  assert.equal(out.length, 2);
  assert.deepEqual(out, [
    [TEXT, delta('A', 'A-m', want.A)],
    [TEXT, delta('B', 'B-m', want.B)],
  ]);
});

test('invalid stream notifications are still dropped and never joined', () => {
  const { d, out, paint } = coalescer();
  d.emit(TEXT, delta('A', 'a1', 'ok'));
  d.emit(TEXT, { ...delta('A', 'a1', ''), delta: { not: 'text' } });
  d.emit(TEXT, delta('A', 'a1', '!'));
  paint();
  assert.deepEqual(out, [[TEXT, delta('A', 'a1', 'ok!')]]);
});

test('keys compare field by field, so ids holding delimiters or a reused item id in another chat never join', () => {
  const { d, out, paint } = coalescer();
  d.emit(TEXT, { threadId: 'A|x', turnId: 'u', itemId: 'y', delta: '1' });
  d.emit(TEXT, { threadId: 'A', turnId: 'u', itemId: 'x|y', delta: '2' });
  d.emit(TEXT, delta('A', 'm', '3'));
  d.emit(TEXT, delta('B', 'm', '4')); // the same local item id in another chat
  d.emit(TEXT, { threadId: 'A|x', turnId: 'u', itemId: 'y', delta: '5' });
  paint();
  assert.deepEqual(
    out.map(([, p]) => `${p.threadId}/${p.itemId}=${p.delta}`),
    ['A|x/y=15', 'A/x|y=2', 'A/m=3', 'B/m=4'],
  );
});
