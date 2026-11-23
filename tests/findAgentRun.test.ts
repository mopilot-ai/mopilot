// src/lib/findAgentRun.ts: finding an agent run by key in a chat's turns or a parent agent's transcript, and its stats line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentRunsIn,
  agentRunsOfTurn,
  agentStatsLine,
  agentToolCalls,
  compactTokens,
  findAgentRun,
  findNestedAgentRun,
} from '../src/lib/findAgentRun.ts';

const run = (key: string, extra: any = {}) => ({ key, description: key, status: 'running', ...extra });
const item = (key: string) => ({ id: `i-${key}`, type: 'dynamicToolCall', agent: run(key) });

test('findAgentRun indexes each turns array once and finds runs by key', () => {
  const turns = [{ items: [item('a'), { id: 'x', type: 'commandExecution' }] }, { items: null }, { items: [item('b')] }];
  assert.equal(findAgentRun(turns, 'b')!.key, 'b');
  assert.equal(findAgentRun(turns, 'missing'), null);
  assert.equal(findAgentRun(null, 'a'), null);
  assert.equal(findAgentRun(undefined, 'a'), null);
  // the index is per array: the same array keeps its first answer
  turns[0] = { items: [...turns[0].items!, item('late')] };
  assert.equal(findAgentRun(turns, 'late'), null);
  assert.equal(findAgentRun([...turns], 'late')!.key, 'late');
  assert.deepEqual(
    agentRunsIn(turns).map((r) => r.key),
    ['a', 'b'],
  );
  assert.deepEqual(agentRunsIn(null), []);
  // a Codex spawn is found by its child thread id
  const codex = [
    { items: [{ id: 's', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['th'], status: 'inProgress' }] },
  ];
  assert.equal(findAgentRun(codex, 'th')!.key, 'th');
});

test('findNestedAgentRun looks through agent transcripts breadth-first, once per agent', () => {
  const turns = [{ items: [item('a'), item('b')] }];
  const threads: Record<string, unknown[]> = {
    a: [item('a1'), { id: 'n', type: 'agentMessage' }, item('b')],
    b: [item('b1')],
    a1: [item('deep'), item('a')],
  };
  const seen: string[] = [];
  const itemsOf = (r: any) => (seen.push(r.key), threads[r.key] ?? []);
  assert.equal(findNestedAgentRun(turns, 'a', itemsOf)!.key, 'a');
  assert.deepEqual(seen, [], 'a top-level run needs no transcript');
  assert.equal(findNestedAgentRun(turns, 'deep', itemsOf)!.key, 'deep');
  assert.deepEqual(seen, ['a', 'b', 'a1']);
  assert.equal(findNestedAgentRun(turns, 'none', itemsOf), null);
  assert.equal(findNestedAgentRun(null, 'none', itemsOf), null);
});

test('stats read like Claude Desktop: tool calls, compact tokens and the duration', () => {
  assert.deepEqual([950, 1000, 1234, 165_432, 2_100_000, 3_000_000].map(compactTokens), ['950', '1k', '1.2k', '165.4k', '2.1M', '3M']);
  assert.equal(
    agentStatsLine({ toolUses: 12, tokens: 165_432, startedAt: 1000, completedAt: 124_000 }),
    '12 tool calls · 165.4k tokens · 2m 3s',
  );
  assert.equal(agentStatsLine({ toolUses: 1, tokens: null, startedAt: null, completedAt: 5 }), '1 tool call');
  assert.equal(agentStatsLine({ toolUses: 0, tokens: 0, startedAt: 5, completedAt: null }), '0 tool calls · 0 tokens');
});

test('the stats line leaves out a tool-call count that is not known, and the count falls back to the loaded transcript', () => {
  assert.equal(agentStatsLine({ toolUses: null, tokens: 1500, startedAt: 0, completedAt: 5000 }), '1.5k tokens · 5s');
  assert.equal(agentStatsLine({ toolUses: null, tokens: null, startedAt: null, completedAt: null }), '');
  const items = [{ type: 'agentMessage' }, { type: 'commandExecution' }, { type: 'reasoning' }, { type: 'mcpToolCall' }];
  assert.equal(agentToolCalls({ toolUses: 7 }, items), 7);
  assert.equal(agentToolCalls({ toolUses: 0 }, items), 2);
  assert.equal(agentToolCalls({ toolUses: 0 }, [{ type: 'agentMessage' }]), 0);
  assert.equal(agentToolCalls({ toolUses: 0 }, []), null);
});

test('source projections use each root turn and propagate its owner to nested agents', () => {
  const parent = { type: 'dynamicToolCall', agent: { key: 'parent', description: 'parent', status: 'completed' } };
  const nested = { type: 'dynamicToolCall', agent: { key: 'nested', description: 'nested', status: 'completed' } };
  const turns = [{ items: [] }, { items: [parent] }];
  const source = { kind: 'claude', key: 'old-native' } as const;
  const at = (turn: number) => {
    assert.equal(turn, 1);
    return source;
  };
  assert.deepEqual(findAgentRun(turns, 'parent', at)?.source, source);
  assert.deepEqual(agentRunsIn(turns, at)[0].source, source);
  assert.deepEqual(findNestedAgentRun(turns, 'nested', () => [nested], at)?.source, source);
  assert.equal(findAgentRun(turns, 'parent')?.source, undefined, 'cached runs are not mutated by a source projection');
});

test("agentRunsOfTurn reads a turn's items once per items array, so a settled turn is not scanned again per streamed frame", () => {
  const settled = [item('a'), { id: 'x', type: 'commandExecution' }];
  const first = agentRunsOfTurn({ items: settled });
  assert.deepEqual(
    first.map((r) => r.key),
    ['a'],
  );
  // a new turn object over the same items (a delta to another turn) reuses the read
  assert.equal(agentRunsOfTurn({ items: settled }), first);
  assert.equal(agentRunsOfTurn({ items: [...settled, item('b')] }).length, 2, 'a new items array is read again');
  assert.deepEqual(agentRunsOfTurn({ items: null }), []);
  assert.equal(agentRunsOfTurn({}), agentRunsOfTurn({ items: undefined }), 'no items share one empty read');
});
