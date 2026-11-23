// Codex sub-agents for the agent page (src/store/codexAgents.ts, src/harness/codexAgentRun.ts): a spawn's run
// enriched from its child thread, the child's stored transcript read page by page, its live turns streamed once
// tracked, and a failed read.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const pages: Record<string, any[]> = {};
const calls: any[] = [];
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: {
    codexApi: {
      threadTurns: async (id: string, p: any) => {
        calls.push([id, p]);
        const list = pages[id];
        if (!list) throw new Error('no such thread');
        return list[p.cursor ? Number(p.cursor) : 0];
      },
    },
  },
});
const A = await import('../src/store/codexAgents.ts');
// the pure half: a spawned agent's run and its child thread's items (src/harness/codexAgentRun.ts)
const R = await import('../src/harness/codexAgentRun.ts');
const T = await import('../src/store/agentThreads.ts');

const spawn = (extra: any = {}) => ({
  type: 'collabAgentToolCall',
  id: 'call-1',
  tool: 'spawnAgent',
  status: 'completed',
  senderThreadId: 'parent',
  receiverThreadIds: ['child-1'],
  prompt: 'Find the bug\nin the parser',
  model: null,
  reasoningEffort: null,
  agentsStates: { 'child-1': { status: 'running', message: null } },
  ...extra,
});
const turn = (id: string, items: any[], startedAt: number | null = 10, completedAt: number | null = 20) => ({
  id,
  status: 'completed',
  items,
  startedAt,
  completedAt,
  durationMs: null,
  error: null,
  diff: null,
});

test('a running spawn takes the child thread nickname, counts its tools and names the one in progress', () => {
  const items = [
    { type: 'userMessage', id: 'u' },
    { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' },
    { type: 'fileChange', id: 'f1', status: 'inProgress' },
    { type: 'agentMessage', id: 'm', text: 'working' },
  ];
  const run = R.codexAgentRun(spawn(), {
    thread: { agentNickname: 'Euler', agentRole: 'worker', model: 'gpt-x' },
    turns: [turn('t', items, 5, null)],
  })!;
  assert.equal(run.key, 'child-1');
  assert.equal(run.description, 'Euler');
  assert.equal(run.model, 'gpt-x');
  assert.equal(run.status, 'running');
  assert.equal(run.toolUses, 2);
  assert.equal(run.tokens, null);
  assert.equal(run.latestTool, 'Editing files');
  assert.equal(run.startedAt, 5000);
  assert.equal(run.completedAt, null);
  assert.equal(run.report, null);
  assert.equal(run.transcript, 'full');
});

test("a child thread's own token usage becomes the agent's tokens", () => {
  const run = R.codexAgentRun(spawn(), { turns: [turn('t', [], 1, 2)], tokens: 4200 })!;
  assert.equal(run.tokens, 4200);
});

test('a settled spawn reports the collab message, else the last reply, and when its last turn ended', () => {
  const done = spawn({ model: 'gpt-y', agentsStates: { 'child-1': { status: 'completed', message: ' Fixed it. ' } } });
  const turns = [
    turn('t1', [{ type: 'agentMessage', id: 'm1', text: 'first' }], 1, 2),
    turn('t2', [{ type: 'agentMessage', id: 'm2', text: ' last ' }], 3, 4),
  ];
  const run = R.codexAgentRun(done, { thread: { agentRole: 'explorer' }, turns })!;
  assert.equal(run.description, 'explorer');
  assert.equal(run.model, 'gpt-y');
  assert.equal(run.report, 'Fixed it.');
  assert.equal(run.startedAt, 1000);
  assert.equal(run.completedAt, 4000);
  const noMessage = spawn({ agentsStates: { 'child-1': { status: 'errored', message: null } } });
  assert.equal(R.codexAgentRun(noMessage, { turns })!.report, 'last');
  assert.equal(R.codexAgentRun(noMessage, { turns })!.status, 'failed');
  // no child turns yet: the prompt titles it, the spawn's own start times it, nothing to report
  const bare = R.codexAgentRun(noMessage, { startedAt: 42 })!;
  assert.equal(bare.description, 'Find the bug');
  assert.equal(bare.startedAt, 42);
  assert.equal(bare.completedAt, null);
  assert.equal(bare.report, null);
  assert.equal(R.codexAgentRun(noMessage)!.startedAt, null);
  // a turn without times
  assert.equal(R.codexAgentRun(noMessage, { turns: [{ items: [] }] })!.completedAt, null);
});

test('items that are no agent launch, or carry an adapter run already, pass through agentRunOf', () => {
  assert.equal(R.codexAgentRun({ type: 'collabAgentToolCall', tool: 'wait' }), null);
  assert.equal(R.codexAgentRun(null), null);
  const agent = { key: 'k', description: 'x' };
  assert.equal(R.codexAgentRun({ type: 'mcpToolCall', agent }), agent);
});

test('tool labels read as the heartbeat', () => {
  assert.equal(R.toolLabel({ type: 'commandExecution', id: '1', command: 'npm test' }), 'Running npm test');
  assert.equal(R.toolLabel({ type: 'commandExecution', id: '1' }), 'Running a command');
  assert.equal(R.toolLabel({ type: 'webSearch', id: '1' }), 'Searching the web');
  assert.equal(R.toolLabel({ type: 'mcpToolCall', id: '1', server: 'gh', tool: 'search' }), 'Using gh.search');
  assert.equal(R.toolLabel({ type: 'collabAgentToolCall', id: '1' }), 'Running agent');
  assert.equal(R.toolLabel({ type: 'dynamicToolCall', id: '1', tool: 'browse' }), 'Using browse');
  assert.equal(R.toolLabel({ type: 'imageView', id: '1' }), 'Using imageView');
  // a turn without items flattens to nothing
  assert.deepEqual(R.flattenTurns([{ items: undefined as any }]), []);
});

test('the stored child transcript is read newest page first and flattened oldest first', async () => {
  pages['child-1'] = [
    { data: [turn('t3', [{ type: 'agentMessage', id: 'c' }]), turn('t2', [{ type: 'agentMessage', id: 'b' }])], nextCursor: '1' },
    { data: [turn('t1', [{ type: 'userMessage', id: 'a' }])], nextCursor: null },
  ];
  calls.length = 0;
  const items = await A.loadCodexAgentThread('chat', { key: 'child-1' } as any);
  assert.deepEqual(
    items.map((i) => i.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(calls, [
    ['child-1', { limit: 50, itemsView: 'full', cursor: null }],
    ['child-1', { limit: 50, itemsView: 'full', cursor: '1' }],
  ]);
  // loading it tracks the child: its live turns now reach this chat's agent page
  const live = [turn('t4', [{ type: 'agentMessage', id: 'd' }])];
  A.codexAgentTurnsChanged('child-1', live);
  assert.equal(T.agentThread('chat', 'child-1').items[0], live[0].items[0]);
  // an endless cursor stops at the page cap
  pages.loop = Array.from({ length: 30 }, (_, i) => ({ data: [turn(`t${i}`, [])], nextCursor: String(i + 1) }));
  assert.equal((await A.readCodexChildTurns('loop')).length, 20);
});

test('a failed child read surfaces on the agent page as an error', async () => {
  T.setAgentThreadLoaderResolver(() => A.loadCodexAgentThread);
  const run = { key: 'missing', transcript: 'full' } as any;
  await T.loadAgentThread('chat-e', run);
  assert.equal(T.agentThread('chat-e', 'missing').error, 'no such thread');
  T.setAgentThreadLoaderResolver(() => null);
});

test('a tracked child thread streams its runtime turns into its agent page, once per turns change', () => {
  const turns = [turn('t', [{ type: 'agentMessage', id: 'x' }])];
  A.codexAgentTurnsChanged('untracked', turns);
  assert.equal(T.agentThread('chat-l', 'untracked').items.length, 0);
  A.trackCodexAgent('chat-l', 'child-l');
  A.codexAgentTurnsChanged('child-l', turns);
  const first = T.agentThread('chat-l', 'child-l');
  assert.equal(first.live, true);
  assert.equal(first.items[0], turns[0].items[0]);
  A.codexAgentTurnsChanged('child-l', turns);
  assert.equal(T.agentThread('chat-l', 'child-l'), first);
});
