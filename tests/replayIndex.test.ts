// Replay work stays linear in history size for Claude and ACP, with first-match identity and ordering preserved.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { buildTurns } from './support/claude-translate.ts';
import { acpConversation, claudeConversation } from './support/replay-fixtures.mjs';

/** Count actual linear-search comparisons, not wall time; restored before any assertion or asynchronous work. */
function scanCount(run: () => unknown) {
  let visits = 0;
  const find = Array.prototype.find;
  const findIndex = Array.prototype.findIndex;
  const count = (original: any) =>
    function (this: unknown[], predicate: any, thisArg: unknown) {
      return original.call(this, (value: unknown, index: number, array: unknown[]) => {
        visits++;
        return predicate.call(thisArg, value, index, array);
      });
    };
  Array.prototype.find = count(find);
  Array.prototype.findIndex = count(findIndex);
  try {
    const value = run();
    return { visits, value };
  } finally {
    Array.prototype.find = find;
    Array.prototype.findIndex = findIndex;
  }
}

test('ACP continuation goes on with the item the replay left open', () => {
  let live: any;
  const out: any[] = [];
  const records = acpConversation(1);
  const turns = buildAcpTurns(records.slice(0, -1), 'chat', '/repo', {
    live: true,
    keep: (tr: any) => (live = tr),
  });
  const last = turns[0].items.at(-1);
  assert.ok(last?.type === 'agentMessage');
  live.continueLive((method: string, params: any) => out.push([method, params]));
  live.onUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' again' },
  });
  assert.deepEqual(out[0][1].itemId, last.id);
  live.endTurn('end_turn', null);
  const completed = out.find(([method]) => method === 'item/completed')[1].item;
  assert.equal(completed.id, last.id);
  assert.equal(completed.text, 'Done again');
  assert.equal(out.at(-1)[1].turn.status, 'completed');
  live.close();
});

for (const [family, fixture, build] of [
  ['Claude', claudeConversation, buildTurns],
  ['ACP', acpConversation, buildAcpTurns],
] as const) {
  test(`${family}: replaying 1,000 turns never repeatedly scans earlier turns`, () => {
    const records = fixture(1000);
    const { value, visits } = scanCount(() => build(records, 'chat', '/repo'));
    assert.equal((value as any[]).length, 1000);
    assert.ok(visits <= records.length * 10, `${visits} comparisons for ${records.length} records`);
  });

  test(`${family}: replaying a 1,000-tool turn never repeatedly scans earlier items`, () => {
    const records = fixture(1, 1000);
    const { value, visits } = scanCount(() => build(records, 'chat', '/repo'));
    const turns = value as any[];
    assert.equal(turns.length, 1);
    assert.equal(turns[0].items.filter((item: any) => item.type === 'commandExecution').length, 1000);
    assert.ok(visits <= records.length * 10, `${visits} comparisons for ${records.length} records`);
  });
}
