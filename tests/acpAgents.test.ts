// ACP sub-agents (core/crates/translate, src/session/harness/acpAgents.ts): a Task/Agent tool call becomes a collab agent
// item with its AgentRun; calls and messages naming it as parent (claude-agent-acp, Qwen meta) become its transcript
// instead of the main turn's items, stream into its agent page, and read back from a replayed chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubStore } from './support/stubs.ts';

const state: any = { runtime: {} };
stubStore({ getState: () => state });
const { AcpTranslator, buildAcpTurns } = await import('../electron/harness/items/acpTranslator.cjs');
const G = await import('../src/session/harness/acpAgents.ts');
const T = await import('../src/store/agentThreads.ts');

function run() {
  const out: [string, any][] = [];
  const tr = new AcpTranslator('chat', '/w', (m: string, p: any) => out.push([m, p]));
  return { tr, out, items: () => out.filter(([, p]) => p.item).map(([, p]) => p) };
}
const task = (extra: any = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId: 'task-1',
  title: 'Explore the repo',
  kind: 'think',
  status: 'in_progress',
  rawInput: { description: 'Map the parser', prompt: 'Read the parser\nand summarise', subagent_type: 'Explore' },
  _meta: { claudeCode: { toolName: 'Task' } },
  ...extra,
});

test('a Task call is a collab agent item: titled by its description, summary transcript, report when done', () => {
  const { tr, items } = run();
  tr.beginTurn('t1');
  tr.onUpdate(task());
  const started = items()[0];
  assert.equal(started.item.type, 'collabAgentToolCall');
  assert.equal(started.item.tool, 'spawnAgent');
  assert.equal(started.item.status, 'inProgress');
  assert.equal(started.item.senderThreadId, 'chat');
  assert.deepEqual(started.item.receiverThreadIds, []);
  const a = started.item.agent;
  assert.deepEqual(
    [a.key, a.description, a.prompt, a.status, a.transcript, a.report, a.background, a.toolUses, a.latestTool],
    ['task-1', 'Map the parser', 'Read the parser\nand summarise', 'running', 'summary', null, false, 0, null],
  );
  tr.onUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'task-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: ' Found it. ' } }],
  });
  const done = items().at(-1);
  assert.equal(done.item.agent.status, 'completed');
  assert.equal(done.item.agent.report, 'Found it.');
});

test('calls and messages naming the agent as parent are its transcript, not the main turn', () => {
  const { tr, out, items } = run();
  tr.beginTurn('t1');
  tr.onUpdate(task());
  tr.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Main reply' } });
  // claude-agent-acp style nested call, then an update that only names its id
  tr.onUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'n1',
    title: 'grep parser',
    kind: 'search',
    status: 'in_progress',
    rawInput: { pattern: 'parser' },
    _meta: { claudeCode: { parentToolUseId: 'task-1' } },
  });
  let agent = items().at(-1).item;
  assert.equal(agent.id, 'task-1');
  assert.equal(agent.agent.transcript, 'full');
  assert.equal(agent.agent.toolUses, 1);
  assert.equal(agent.agent.latestTool, 'grep parser');
  tr.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'n1', status: 'completed' });
  agent = items().at(-1).item;
  assert.equal(agent.agentItems.length, 1);
  assert.equal(agent.agentItems[0].status, 'completed');
  assert.equal(agent.agent.latestTool, null);
  // Qwen style nested message and thought chunks stream into the agent's own items
  const meta = { parentToolCallId: 'task-1' };
  tr.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think ' }, _meta: meta });
  tr.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'more' }, _meta: meta });
  tr.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sub ' }, _meta: meta });
  tr.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' }, _meta: meta });
  tr.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'audio' }, _meta: meta });
  agent = items().at(-1).item;
  assert.deepEqual(
    agent.agentItems.map((i: any) => [i.type, i.id, i.text ?? i.summary?.[0] ?? i.command]),
    [
      ['commandExecution', 'n1', 'grep parser'],
      ['reasoning', 'task-1:r0', 'think more'],
      ['agentMessage', 'task-1:m1', 'Sub reply'],
    ],
  );
  // the main turn shows the agent item and its own reply, none of the nested ones
  tr.endTurn('end_turn', null);
  const main = out.filter(([, p]) => p.item).map(([, p]) => p.item.id);
  assert.ok(!main.includes('n1'));
  assert.ok(main.includes('t1:m0'));
  // a call naming an unknown parent stays a main-turn card
  tr.beginTurn('t2');
  tr.onUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'o',
    title: 'ls',
    kind: 'execute',
    status: 'completed',
    _meta: { parentToolCallId: 'nobody' },
  });
  assert.equal(items().at(-1).turnId, 't2');
  assert.equal(items().at(-1).item.type, 'commandExecution');
});

test('an agent reporting after its turn ended updates its item in the turn that launched it', () => {
  const { tr, items } = run();
  tr.beginTurn('t1');
  tr.onUpdate(task({ rawInput: { prompt: 'bg', run_in_background: true } }));
  tr.endTurn('cancelled', null);
  const ended = items().at(-1);
  assert.equal(ended.item.agent.status, 'stopped');
  tr.onUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'late',
    title: 'Read a.ts',
    kind: 'read',
    status: 'completed',
    _meta: { parentToolCallId: 'task-1' },
  });
  const late = items().at(-1);
  assert.equal(late.turnId, 't1');
  assert.equal(late.item.agentItems[0].id, 'late');
  assert.equal(late.item.agent.status, 'stopped');
});

test('a call that is recognised only once an update names its tool becomes an agent then', () => {
  const { tr, items } = run();
  tr.beginTurn('t1');
  tr.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'q1', title: 'Delegate', status: 'in_progress' });
  assert.equal(items().at(-1).item.type, 'mcpToolCall');
  tr.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'q1', _meta: { toolName: 'agent' }, rawInput: { prompt: 'p' } });
  assert.equal(items().at(-1).item.type, 'collabAgentToolCall');
  tr.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'q1', status: 'completed' });
  assert.equal(items().at(-1).item.agent.status, 'completed');
});

test('a replayed chat carries the transcript on the agent item, which the ACP loader reads back', async () => {
  const records = [
    { t: 'user', turnId: 't1', user: { id: 'u', clientId: null, content: [] } },
    { t: 'update', turnId: 't1', update: task() },
    {
      t: 'update',
      turnId: 't1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'n1',
        title: 'grep',
        kind: 'search',
        status: 'completed',
        _meta: { parentToolCallId: 'task-1' },
      },
    },
    { t: 'update', turnId: 't1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'task-1', status: 'completed' } },
    { t: 'update', turnId: 't1', update: task({ toolCallId: 'task-2', _meta: { toolName: 'agent' } }) },
    { t: 'end', turnId: 't1', stopReason: 'end_turn' },
  ];
  const turns = buildAcpTurns(records as any, 'chat', '/w');
  assert.deepEqual(
    turns[0].items.map((i: any) => i.id),
    ['u', 'task-1', 'task-2'],
  );
  state.runtime.chat = { turns };
  assert.deepEqual(
    (await G.loadAcpAgentThread('chat', { key: 'task-1' } as any)).map((i) => i.id),
    ['n1'],
  );
  assert.deepEqual(await G.loadAcpAgentThread('chat', { key: 'task-2' } as any), []);
  assert.deepEqual(await G.loadAcpAgentThread('chat', { key: 'none' } as any), []);
  assert.deepEqual(await G.loadAcpAgentThread('other', { key: 'task-1' } as any), []);
  state.runtime.odd = { turns: [{ items: [{ type: 'collabAgentToolCall', id: 'k' }] }] };
  assert.deepEqual(await G.loadAcpAgentThread('odd', { key: 'k' } as any), []);
});

test('live: the chat emit streams an agent item carrying a transcript into its agent page', () => {
  const seen: string[] = [];
  const emit = G.acpAgentEmit('chat-live', (m) => seen.push(m));
  const items = [{ type: 'agentMessage', id: 'x' }];
  emit('item/completed', { item: { type: 'collabAgentToolCall', id: 'a1', agentItems: items } });
  emit('item/completed', { item: { type: 'collabAgentToolCall', id: 'a2', agentItems: [] } });
  emit('item/completed', { item: { type: 'mcpToolCall', id: 'a3' } });
  emit('turn/completed', { turn: {} });
  assert.equal(seen.length, 4);
  assert.equal(T.agentThread('chat-live', 'a1').items, items);
  assert.equal(T.agentThread('chat-live', 'a1').live, true);
  assert.equal(T.agentThread('chat-live', 'a2').items.length, 0);
});

test('an untitled running sub-call reads as "Tool"; updating one keeps the others in place', () => {
  const { tr, items } = run();
  tr.beginTurn('t1');
  tr.onUpdate(task());
  const meta = { parentToolCallId: 'task-1' };
  tr.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'first', status: 'completed', _meta: meta });
  tr.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'b', status: 'in_progress', _meta: meta });
  assert.equal(items().at(-1).item.agent.latestTool, 'Tool');
  tr.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' });
  assert.deepEqual(
    items()
      .at(-1)
      .item.agentItems.map((i: any) => [i.id, i.status]),
    [
      ['a', 'completed'],
      ['b', 'completed'],
    ],
  );
});
