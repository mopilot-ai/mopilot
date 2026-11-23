// The prose-only cut of a chat's turns (shared/assistantReplies.mjs): every turn stays for segment slicing, replies of finished turns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantReplies, proseTurns } from '../shared/assistantReplies.mjs';

const turns = [
  {
    id: 'a',
    status: 'completed',
    items: [{ type: 'userMessage' }, { type: 'agentMessage', text: 'done' }, { type: 'commandExecution' }, null],
  },
  { id: 'b', status: 'inProgress', items: [{ type: 'agentMessage', text: 'partial' }] },
  { id: 'c', status: 'completed', items: 'broken' },
];

test('prose turns keep every turn, so per-segment counts still slice, with only agent messages; a malformed item list is empty', () => {
  const out = proseTurns(turns);
  assert.deepEqual(
    out.map((t: any) => t.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    out.map((t: any) => t.items.length),
    [1, 1, 0],
  );
});

test('assistant replies are the finished turns only', () => {
  assert.deepEqual(
    assistantReplies(turns).map((t: any) => t.id),
    ['a', 'c'],
  );
});
