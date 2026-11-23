// Where a saved chat note goes back when its turn is not among the turns shown (src/lib/chatMeta.ts withChatNotes, #1949).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withChatNotes } from '../src/lib/chatMeta.ts';

const note = (over: object) => ({
  id: 'answers-1',
  kind: 'answers' as const,
  text: 'Answered a question',
  answers: [{ question: 'Which statistic should be added next?', answer: 'range' }],
  turnId: 'ct-556333b0-322a-463e-a387-a13ff9a09a22',
  turn: 7,
  at: 1_000_000,
  ...over,
});
const shown = (turns: any[]) => turns.map((t) => t.items.map((i: any) => i.id));

test('a note whose turn is older than the turns shown (compacted or not paged in yet) shows nowhere', () => {
  // after /compact the read starts at the compaction: every turn shown began after the note was written
  const turns = [
    { id: 'h-c1', startedAt: 1_100, items: [{ id: 'c' }] },
    { id: 'h-r1', startedAt: 1_200, items: [{ id: 'u' }] },
  ];
  assert.deepEqual(shown(withChatNotes(turns, [note({})])), [['c'], ['u']]);
});

test('a note whose turn id is not shown goes after the latest shown turn that began before it was written', () => {
  const turns = [
    { id: 'h-a', startedAt: 900, items: [] },
    { id: 'h-b', startedAt: 990, items: [] },
    { id: 'h-c', startedAt: 1_100, items: [] },
  ];
  assert.deepEqual(shown(withChatNotes(turns, [note({ turnId: 'gone' })])), [[], ['answers-1'], []]);
  // a turn with no start time is passed over, not taken as the latest
  const untimedLast = [turns[0], { id: 'h-x', startedAt: null, items: [] }];
  assert.deepEqual(shown(withChatNotes(untimedLast, [note({ turnId: 'gone' })])), [['answers-1'], []]);
});

test('its own turn shown, or no turn id at all, places it as before', () => {
  const turns = [
    { id: 'h-556333b0-322a-463e-a387-a13ff9a09a22', startedAt: 999, items: [] },
    { id: 'h-z', startedAt: 1_100, items: [] },
  ];
  assert.deepEqual(shown(withChatNotes(turns, [note({})])), [['answers-1'], []]);
  // no turn id (a computer-use refusal): the index, clamped to the latest turn
  assert.deepEqual(shown(withChatNotes(turns, [note({ turnId: null, turn: Number.MAX_SAFE_INTEGER })])), [[], ['answers-1']]);
  // turns with no times at all (older harness reads): the saved index, as before
  const untimed = [
    { id: 'a', items: [] },
    { id: 'b', items: [] },
  ];
  assert.deepEqual(shown(withChatNotes(untimed, [note({ turnId: 'gone', turn: 0 })])), [['answers-1'], []]);
});

test('a note without a saved turn index shows nowhere instead of breaking the turns', () => {
  const turns = [{ id: 'h-a', items: [{ id: 'a' }] }];
  for (const turn of [undefined, null, 'one', Number.NaN])
    assert.deepEqual(shown(withChatNotes(turns, [note({ turnId: undefined, turn })])), [['a']]);
});
