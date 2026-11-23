// A fork's copied conversation read back as turns (core/crates/translate/src/claude): the first prompt after the
// copy is a turn of its own, even when the copy ends mid-call (a linked fork start_session made, #3209).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from './support/claude-translate.ts';

const BRIEF = '12345678-1234-1234-1234-123456789abc';
const copied = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Start a fork' } },
  {
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__sage__start_session', input: {} }] },
  },
];
const brief = [
  { type: 'user', uuid: BRIEF, message: { role: 'user', content: 'Report the fork result' } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } },
];
const userTexts = (t: any) => t.items.filter((i: any) => i.type === 'userMessage').length;

test("the fork's own first prompt starts its own turn after a copy that ends mid-call", () => {
  const turns = buildTurns([copied[0], { ...copied[1], forkedFrom: true }, ...brief], 'claude:f', '/repo');
  assert.deepEqual(
    turns.map((t: any) => t.id),
    ['h-u1', `h-${BRIEF}`],
  );
  assert.equal(turns[0].status, 'completed');
  assert.deepEqual(turns.map(userTexts), [1, 1]);
});

test('without a fork, a prompt after a tool call is still a message sent mid-turn', () => {
  const turns = buildTurns([...copied, ...brief], 'claude:s', '/repo');
  assert.deepEqual(
    turns.map((t: any) => t.id),
    ['h-u1'],
  );
  assert.equal(userTexts(turns[0]), 2);
});
