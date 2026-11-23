// A Codex chat's tasks in the store (src/store/codexTasks.ts): polls publish them, settled ones get one card, stops, other harnesses skipped.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { stubSlice, stubStore } from './support/stubs.ts';

const state: any = { runtime: {}, threads: {}, paneTabs: [{ threadId: 'c7' }], route: { name: 'home' }, split: null };
let harness = 'codex';
const natives = new Map<string, string>();
let terminalCalls = 0;
let blocked: string | null = null;
let terminals: any = { data: [] };
let terminate = true;
const childPages: Record<string, any> = {};
const io: any[] = [];
const familyOf = (id: string) => ((natives.get(id) ?? id).startsWith('acp:') ? 'acp' : harness);
stubSlice('src/store/chats.ts', { chatFamily: familyOf, nativeOf: (id: string) => natives.get(id) ?? id });
stubStore({
  getState: () => state,
  nativeOf: (id: string) => natives.get(id) ?? id,
  blockedReason: () => blocked,
  patchTurn: (chatId: string, turnId: string, fn: any) => {
    const t = state.runtime[chatId].turns.find((x: any) => x.id === turnId);
    Object.assign(t, fn(t));
  },
  terminateBackgroundTerminal: async (chatId: string, pid: string) => (io.push(['terminate', chatId, pid]), terminate),
  toast: (text: string) => io.push(['toast', text]),
});
let interruptWait: Promise<void> | null = null;
let interruptFails: false | 'error' | 'plain' = false;
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: {
    codexApi: {
      backgroundTerminals: async () => {
        terminalCalls++;
        if (terminals instanceof Error) throw terminals;
        return terminals;
      },
      turnInterrupt: async (threadId: string, turnId: string) => {
        io.push(['request', 'turn/interrupt', { threadId, turnId }]);
        await interruptWait;
        if (interruptFails === 'plain') throw 'refused';
        if (interruptFails) throw new Error('no such turn');
      },
      threadTurns: async (id: string) => {
        io.push(['turns', id]);
        if (!childPages[id]) throw new Error('gone');
        return childPages[id];
      },
    },
  },
});
const P = await import('../src/store/codexTasks.ts');
const T = await import('../src/store/agentThreads.ts');
const A = await import('../src/store/codexAgents.ts');

const term = (pid: string) => ({ itemId: `item-${pid}`, processId: pid, command: `cmd ${pid}`, cwd: '/', osPid: null });
const spawn = (child: string, status: string) => ({
  type: 'collabAgentToolCall',
  id: `call-${child}`,
  tool: 'spawnAgent',
  status: 'completed',
  receiverThreadIds: [child],
  prompt: `Do ${child}`,
  model: null,
  agentsStates: { [child]: { status, message: null } },
});

test('a poll publishes shells and agents; a shell that ends gets one task card in the latest turn', async () => {
  state.runtime.c1 = { loaded: true, turns: [{ id: 't1', items: [] }] };
  terminals = { data: [] };
  await P.pollCodexTasks('c1');
  state.runtime.c1.turns[0].items.push({ type: 'commandExecution', id: 'item-p', aggregatedOutput: 'out' });
  terminals = { data: [term('p')] };
  await P.pollCodexTasks('c1');
  const [shell] = P.codexTasks('c1');
  assert.equal(shell.id, 'codex-shell:p');
  assert.equal(P.codexTaskOutput('c1', shell), 'out');
  assert.equal(P.codexTaskOutput('c1', { ...shell, output: null }), null);
  assert.equal(P.codexTaskOutput('nochat', shell), null);

  terminals = { data: [] };
  await P.pollCodexTasks('c1');
  assert.equal(P.codexTasks('c1')[0].status, 'completed');
  const notes = state.runtime.c1.turns[0].items.filter((i: any) => i.type === 'statusNote');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'task');
  assert.equal(notes[0].task.taskId, 'codex-shell:p');
  assert.equal(notes[0].task.status, 'completed');
});

test("a background terminal's command item is flagged once, so its transcript row follows the task", async () => {
  const items = [
    { type: 'commandExecution', id: 'item-bg', command: 'sleep 100', status: 'completed' },
    { type: 'commandExecution', id: 'item-done', command: 'ls', status: 'completed' },
    { type: 'agentMessage', id: 'item-bg' },
  ];
  state.runtime.cb = {
    loaded: true,
    turns: [
      { id: 't1', items },
      { id: 't2', items: [{ type: 'commandExecution', id: 'item-other' }] },
    ],
  };
  terminals = { data: [term('bg')] };
  terminals.data[0].itemId = 'item-bg';
  await P.pollCodexTasks('cb');
  const flags = () => state.runtime.cb.turns[0].items.map((i: any) => i.background === true);
  assert.deepEqual(flags(), [true, false, false]);
  // a second poll patches nothing more, and a terminal list that failed or is empty flags nothing
  const after = state.runtime.cb.turns[0].items;
  await P.pollCodexTasks('cb');
  assert.equal(state.runtime.cb.turns[0].items, after);
  terminals = new Error('app-server gone');
  await P.pollCodexTasks('cb');
  assert.equal(state.runtime.cb.turns[0].items, after);
});

test('a shell gets its card as it starts and the same card settles in place; one already there at the first read gets none', async () => {
  const items = (id: string) => state.runtime[id].turns.flatMap((t: any) => t.items).filter((i: any) => i.type === 'statusNote');
  state.runtime.cs = {
    loaded: true,
    turns: [
      { id: 'old', items: [] },
      { id: 'new', items: [] },
    ],
  };
  terminals = { data: [] };
  await P.pollCodexTasks('cs');
  terminals = { data: [term('s')] };
  await P.pollCodexTasks('cs');
  assert.deepEqual(
    items('cs').map((n: any) => [n.id, n.task.status]),
    [['task-codex-shell:s', 'running']],
  );
  assert.equal(state.runtime.cs.turns[1].items.at(-1).id, 'task-codex-shell:s');
  // another poll with the shell still running changes nothing; a new turn arrives, then the shell ends
  const before = state.runtime.cs.turns[1].items;
  await P.pollCodexTasks('cs');
  assert.equal(state.runtime.cs.turns[1].items, before);
  state.runtime.cs.turns.push({ id: 'later', items: [] });
  terminals = { data: [] };
  await P.pollCodexTasks('cs');
  assert.deepEqual(
    items('cs').map((n: any) => [n.id, n.task.status]),
    [['task-codex-shell:s', 'completed']],
  );
  assert.equal(state.runtime.cs.turns[2].items.length, 0);
  // a shell already running at the first read (an opened chat) is listed but gets no card, running or settled
  state.runtime.co = { loaded: true, turns: [{ id: 't', items: [] }] };
  terminals = { data: [term('o')] };
  await P.pollCodexTasks('co');
  assert.equal(P.codexTasks('co')[0].status, 'running');
  terminals = { data: [] };
  await P.pollCodexTasks('co');
  assert.equal(P.codexTasks('co')[0].status, 'completed');
  assert.equal(items('co').length, 0);
});

test('an agent that settles on first sight (an opened chat) gets no card in a newer turn', async () => {
  state.runtime.ca = {
    loaded: true,
    turns: [
      { id: 't1', items: [spawn('old1', 'running')] },
      { id: 't2', items: [] },
    ],
  };
  terminals = { data: [] };
  await P.pollCodexTasks('ca');
  state.runtime.ca.turns[0].items[0] = spawn('old1', 'completed');
  await P.pollCodexTasks('ca');
  assert.equal(P.codexTasks('ca')[0].status, 'completed');
  assert.equal(state.runtime.ca.turns[1].items.length, 0);
});

test('a settle with no turn on screen, or one already noted, adds no card', async () => {
  terminals = { data: [term('q')] };
  await P.pollCodexTasks('c-empty');
  terminals = { data: [] };
  await P.pollCodexTasks('c-empty');
  assert.equal(P.codexTasks('c-empty')[0].status, 'completed');
  assert.equal(state.runtime['c-empty'], undefined);

  state.runtime.c2 = { loaded: true, turns: [{ id: 't', items: [{ type: 'statusNote', id: 'task-codex-shell:r' }] }] };
  terminals = { data: [term('r')] };
  await P.pollCodexTasks('c2');
  terminals = { data: [] };
  await P.pollCodexTasks('c2');
  assert.equal(state.runtime.c2.turns[0].items.length, 1);
});

test('a terminal list that fails keeps shells running', async () => {
  terminals = { data: [term('s')] };
  await P.pollCodexTasks('c3');
  terminals = new Error('app-server gone');
  await P.pollCodexTasks('c3');
  assert.equal(P.codexTasks('c3')[0].status, 'running');
});

test('other harnesses, ACP chats and blocked chats are not polled; one poll at a time per chat', async () => {
  terminals = { data: [term('x')] };
  harness = 'claude';
  await P.pollCodexTasks('c4');
  harness = 'codex';
  blocked = 'too old';
  await P.pollCodexTasks('c4');
  blocked = null;
  await P.pollCodexTasks('acp:kimi:1');
  assert.deepEqual(P.codexTasks('c4'), []);
  assert.deepEqual(P.codexTasks('acp:kimi:1'), []);
  await Promise.all([P.pollCodexTasks('c4'), P.pollCodexTasks('c4')]);
  assert.equal(P.codexTasks('c4').length, 1);
});

test("an ACP chat's sub-agents become tasks from its turns, with no terminal list and no child thread read; a blocked one is skipped", async () => {
  const run = (status: string) => ({
    key: 'tc1',
    description: 'Explore the repo',
    prompt: 'Look around',
    model: null,
    background: false,
    status,
    toolUses: 2,
    latestTool: null,
    tokens: null,
    startedAt: Date.now(),
    completedAt: status === 'running' ? null : Date.now() + 4000,
    report: null,
    transcript: 'summary',
  });
  const acp = 'acp:kimi:7';
  state.runtime[acp] = { loaded: true, turns: [{ id: 't1', items: [] }] };
  io.length = 0;
  blocked = 'too old';
  await P.pollCodexTasks(acp);
  assert.deepEqual(P.codexTasks(acp), []);
  blocked = null;
  await P.pollCodexTasks(acp);
  state.runtime[acp].turns[0].items.push({ type: 'collabAgentToolCall', id: 'tc1', agent: run('running') });
  await P.pollCodexTasks(acp);
  assert.deepEqual(
    P.codexTasks(acp).map((t: any) => [t.type, t.status, t.description, t.agentKey, t.stoppable]),
    [['local_agent', 'running', 'Explore the repo', 'tc1', false]],
  );
  // it settles with its call: listed as finished, with one card in the transcript, and nothing but the turns was read
  state.runtime[acp].turns[0].items[0].agent = run('completed');
  await P.pollCodexTasks(acp);
  assert.equal(P.codexTasks(acp)[0].status, 'completed');
  assert.ok(state.runtime[acp].turns[0].items.some((i: any) => i.id === 'task-codex-agent:tc1'));
  assert.deepEqual(io, []);
});

test('stopping: a shell is terminated and settles as stopped; refusals and agents return false', async () => {
  terminals = { data: [term('k')] };
  await P.pollCodexTasks('c5');
  const shell = P.codexTasks('c5')[0];
  terminate = false;
  assert.equal(await P.stopCodexTask('c5', shell), false);
  terminate = true;
  terminals = { data: [] };
  assert.equal(await P.stopCodexTask('c5', shell), true);
  assert.deepEqual(io.filter((x) => x[0] === 'terminate').slice(-1), [['terminate', 'c5', 'k']]);
  assert.equal(P.codexTasks('c5')[0].status, 'stopped');
  assert.equal(await P.stopCodexTask('c5', { ...shell, stoppable: false }), false);
  assert.equal(await P.stopCodexTask('c5', { id: 'codex-agent:a' } as any), false);
});

test('agents: a viewed running agent is re-read each poll unless its child thread is loaded here', async () => {
  terminals = { data: [] };
  state.runtime.c6 = {
    loaded: true,
    turns: [{ id: 't', items: [spawn('k1', 'running'), spawn('k2', 'running'), spawn('k3', 'completed')] }],
  };
  state.runtime.k2 = {
    loaded: true,
    tokenUsage: { total: { totalTokens: 1234 } },
    turns: [{ id: 'x', items: [{ type: 'agentMessage', id: 'live' }] }],
  };
  childPages.k1 = { data: [{ id: 'ct', items: [{ type: 'agentMessage', id: 'stored' }] }], nextCursor: null };
  A.trackCodexAgent('c6', 'k1');
  io.length = 0;
  await P.pollCodexTasks('c6');
  // k1 is re-read; k2 streams from its runtime; k3 settled before this window saw it run
  assert.deepEqual(io, [['turns', 'k1']]);
  assert.equal(T.agentThread('c6', 'k1').items[0].id, 'stored');
  assert.equal(P.codexTasks('c6').find((t) => t.agentKey === 'k2')!.toolUses, 0);
  assert.equal(P.codexTasks('c6').find((t) => t.agentKey === 'k2')!.tokens, 1234);
  assert.equal(P.codexTasks('c6').find((t) => t.agentKey === 'k1')!.tokens, null);
  // the agent page's items feed the heartbeat when the child runtime isn't loaded
  T.putAgentItems('c6', 'k1', [{ type: 'commandExecution', id: 'cx', command: 'make', status: 'inProgress' }]);
  childPages.k1 = undefined;
  await P.pollCodexTasks('c6');
  assert.equal(P.codexTasks('c6').find((t) => t.agentKey === 'k1')!.latestTool, 'Running make');
  // a failed re-read keeps what the page showed
  assert.equal(T.agentThread('c6', 'k1').items[0].id, 'cx');
});

test("an agent whose child thread ended its turn settles on the parent's spawn item, from the stored thread or the loaded one", async () => {
  terminals = { data: [] };
  const states = (chat: string, key: string) =>
    state.runtime[chat].turns[0].items.find((i: any) => i.id === `call-${key}`).agentsStates[key];
  const page = (status: string, text: string) => ({
    data: [{ id: 'ct', status, items: [{ type: 'agentMessage', id: 'm', text }] }],
    nextCursor: null,
  });
  state.runtime.c9 = {
    loaded: true,
    turns: [{ id: 't', items: [spawn('s1', 'running'), spawn('s2', 'running'), spawn('s3', 'running'), spawn('s4', 'running')] }],
  };
  for (const k of ['s1', 's2', 's3', 's4']) A.trackCodexAgent('c9', k);
  // s1: stored, finished; s2: still running; s3: the loaded child thread failed; s4: the parent already settled it
  childPages.s1 = page('completed', 'hi');
  childPages.s2 = page('inProgress', 'working');
  state.runtime.s3 = { loaded: true, turns: [{ id: 'x', status: 'failed', items: [{ type: 'agentMessage', id: 'l', text: '' }] }] };
  childPages.s4 = page('completed', 'ignored');
  state.runtime.c9.turns[0].items[3].agentsStates.s4 = { status: 'shutdown', message: 'closed by the parent' };
  await P.pollCodexTasks('c9');
  assert.deepEqual([states('c9', 's1').status, states('c9', 's1').message], ['completed', 'hi']);
  assert.equal(states('c9', 's2').status, 'running');
  assert.deepEqual([states('c9', 's3').status, states('c9', 's3').message], ['errored', null]);
  assert.deepEqual([states('c9', 's4').status, states('c9', 's4').message], ['shutdown', 'closed by the parent']);
  // the tasks follow: settled ones are finished and get their card, the running one is not
  const by = (k: string) => P.codexTasks('c9').find((t) => t.agentKey === k)!;
  await P.pollCodexTasks('c9');
  assert.deepEqual([by('s1').status, by('s2').status, by('s3').status], ['completed', 'running', 'failed']);
  // a spawn item with no recorded states gets them; a turn that states no status, and a collab item with no thread ids, change nothing
  const bare = {
    type: 'collabAgentToolCall',
    id: 'call-s6',
    tool: 'spawnAgent',
    status: 'inProgress',
    receiverThreadIds: ['s6'],
    prompt: 'p',
    model: null,
  };
  const noIds = { type: 'collabAgentToolCall', id: 'call-s7', tool: 'spawnAgent', status: 'inProgress', prompt: 'p', model: null };
  state.runtime.c9.turns[0].items.unshift(noIds);
  state.runtime.c9.turns[0].items.push(bare, { ...bare, id: 'call-s9', receiverThreadIds: ['s9'], agentsStates: {} });
  childPages.s9 = page('failed', 'oops');
  A.trackCodexAgent('c9', 's9');
  childPages.s6 = page('completed', 'bare done');
  A.trackCodexAgent('c9', 's6');
  await P.pollCodexTasks('c9');
  assert.deepEqual([states('c9', 's6').status, states('c9', 's6').message], ['completed', 'bare done']);
  assert.deepEqual([states('c9', 's9').status, states('c9', 's9').message], ['errored', 'oops']);
  childPages.s8 = { data: [{ id: 'ct', items: [] }], nextCursor: null };
  state.runtime.c9.turns[0].items.push({ ...spawn('s8', 'running') });
  A.trackCodexAgent('c9', 's8');
  await P.pollCodexTasks('c9');
  assert.equal(states('c9', 's8').status, 'running');
  // the spawn item can sit in a later turn, and a child whose message has no text has nothing to say
  state.runtime.c9.turns.push({ id: 't2', items: [spawn('sA', 'running')] });
  childPages.sA = { data: [{ id: 'ct', status: 'completed', items: [{ type: 'agentMessage', id: 'm' }] }], nextCursor: null };
  A.trackCodexAgent('c9', 'sA');
  await P.pollCodexTasks('c9');
  const later = state.runtime.c9.turns[1].items[0].agentsStates.sA;
  assert.deepEqual([later.status, later.message], ['completed', null]);
  // a task kept from the last poll whose spawn item is no longer on screen is refreshed without finding it, and stays as it was
  state.runtime.c11 = { loaded: true, turns: [{ id: 't', items: [spawn('sB', 'running')] }] };
  childPages.sB = page('completed', 'gone');
  A.trackCodexAgent('c11', 'sB');
  await P.pollCodexTasks('c11');
  state.runtime.c11.turns[0].items = [];
  childPages.sB = page('completed', 'gone');
  await P.pollCodexTasks('c11');
  assert.equal(P.codexTasks('c11').find((t) => t.agentKey === 'sB')!.status, 'running');
  // a child with no spawn item in this chat (or no turns yet) changes nothing
  A.trackCodexAgent('c9', 'orphan');
  state.runtime.c9.turns[0].items.push({ ...spawn('s5', 'running'), receiverThreadIds: ['s5'] });
  childPages.s5 = { data: [], nextCursor: null };
  await P.pollCodexTasks('c9');
  assert.equal(states('c9', 's5').status, 'running');
});

test("stopping a sub-agent interrupts the turn its child thread runs, and says when it can't", async () => {
  terminals = { data: [] };
  const page = (status: string) => ({ data: [{ id: 'turn-9', status, items: [] }], nextCursor: null });
  state.runtime.c10 = { loaded: true, turns: [{ id: 't', items: [spawn('a1', 'running')] }] };
  A.trackCodexAgent('c10', 'a1');
  childPages.a1 = page('inProgress');
  await P.pollCodexTasks('c10');
  const agent = P.codexTasks('c10').find((t) => t.agentKey === 'a1')!;
  assert.equal(agent.stoppable, true);
  io.length = 0;
  assert.equal(await P.stopCodexTask('c10', agent), true);
  assert.deepEqual(
    io.filter((x) => x[0] === 'request'),
    [['request', 'turn/interrupt', { threadId: 'a1', turnId: 'turn-9' }]],
  );
  // the child's turn already ended: nothing to interrupt; the button says so with the shared line (liveAction)
  childPages.a1 = page('completed');
  io.length = 0;
  assert.equal(await P.stopCodexTask('c10', agent), 'retired');
  assert.equal(io.filter((x) => x[0] !== 'turns').length, 0, "no toast: the shared line is the button's");
  // the app-server refuses, or the child can't be read: said, not hidden
  childPages.a1 = page('inProgress');
  interruptFails = 'error';
  io.length = 0;
  assert.equal(await P.stopCodexTask('c10', agent), false);
  assert.deepEqual(
    io.filter((x) => x[0] === 'toast'),
    [['toast', "Couldn't stop the agent: no such turn"]],
  );
  interruptFails = 'plain';
  io.length = 0;
  assert.equal(await P.stopCodexTask('c10', agent), false);
  assert.deepEqual(
    io.filter((x) => x[0] === 'toast'),
    [['toast', "Couldn't stop the agent: refused"]],
  );
  interruptFails = false;
  childPages.a1 = undefined;
  io.length = 0;
  assert.equal(await P.stopCodexTask('c10', agent), false);
  assert.equal(io.filter((x) => x[0] === 'toast').length, 1);
  assert.equal(await P.stopCodexTask('c10', { ...agent, stoppable: false }), false);
});

test('the poller is counted: it polls at once and stops with its last holder', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  terminals = { data: [term('z')] };
  P.startCodexTaskPoller('c7');
  P.startCodexTaskPoller('c7');
  await new Promise((r) => setImmediate(r));
  assert.equal(P.codexTasks('c7').length, 1);
  terminals = { data: [] };
  P.stopCodexTaskPoller('c7');
  t.mock.timers.tick(P.POLL_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(P.codexTasks('c7')[0].status, 'completed');
  P.stopCodexTaskPoller('c7');
  P.stopCodexTaskPoller('c7');
  terminals = { data: [term('z2')] };
  t.mock.timers.tick(P.POLL_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(P.codexTasks('c7').length, 1);
});

test('a terminal list from the old harness cannot publish into a switched chat', async () => {
  harness = 'codex';
  blocked = null;
  const chat = 'switched-while-listing';
  state.runtime[chat] = { loaded: true, turns: [{ id: 'new-turn', items: [] }] };
  let release!: (value: any) => void;
  terminals = new Promise((resolve) => (release = resolve));
  const pending = P.pollCodexTasks(chat);
  harness = 'claude';
  release({ data: [term('old-process')] });
  await pending;
  assert.deepEqual(P.codexTasks(chat), []);
  assert.deepEqual(state.runtime[chat].turns[0].items, []);
  harness = 'codex';
  terminals = { data: [] };
});

test('a new native source can poll while its predecessor is pending, without inheriting its tasks', async () => {
  const chat = 'overlapping-source-reads';
  harness = 'codex';
  state.runtime[chat] = { loaded: true, turns: [{ id: 't', items: [] }] };
  natives.set(chat, 'first');
  let oldAnswer!: (value: any) => void;
  terminals = new Promise((resolve) => (oldAnswer = resolve));
  const old = P.pollCodexTasks(chat);
  natives.set(chat, 'second');
  let newAnswer!: (value: any) => void;
  terminals = new Promise((resolve) => (newAnswer = resolve));
  const current = P.pollCodexTasks(chat);
  const calls = terminalCalls;
  oldAnswer({ data: [term('retired')] });
  await old;
  assert.deepEqual(P.codexTasks(chat), []);
  await P.pollCodexTasks(chat);
  assert.equal(terminalCalls, calls, 'the old finally must not release the replacement single-flight');
  newAnswer({ data: [term('current')] });
  await current;
  assert.equal(P.codexTasks(chat)[0].description, 'cmd current');
  const stale = P.codexTasks(chat)[0];
  natives.set(chat, 'third');
  assert.deepEqual(P.codexTasks(chat), [], 'cached tasks belong to their native source');
  io.length = 0;
  // a task of the segment the chat switched away from is retired: its button says so, and nothing is terminated
  assert.equal(await P.stopCodexTask(chat, { ...stale, description: 'UI-enriched row' }), 'retired');
  assert.equal(await P.stopCodexTask(chat, stale), 'retired');
  assert.deepEqual(io, [], 'a retained old task cannot terminate a replacement process with the same id');
  state.runtime[chat].turns[0].items.push({ type: 'commandExecution', id: 'item-current', aggregatedOutput: 'replacement output' });
  assert.equal(P.codexTaskOutput(chat, stale), null, 'an old task cannot read a replacement command with the same item id');
  terminals = { data: [] };
  await P.pollCodexTasks(chat);
  assert.deepEqual(P.codexTasks(chat), []);
});

test('an agent refresh cannot publish or settle the replacement chat after a switch', async () => {
  const chat = 'switched-agent-refresh';
  const child = 'slow-child';
  harness = 'codex';
  terminals = { data: [] };
  state.runtime[chat] = { loaded: true, turns: [{ id: 't', items: [spawn(child, 'running'), spawn('must-not-refresh', 'running')] }] };
  let answer!: (value: any) => void;
  childPages[child] = new Promise((resolve) => (answer = resolve));
  const pending = P.pollCodexTasks(chat);
  await new Promise((resolve) => setImmediate(resolve));
  natives.set(chat, 'replacement-native');
  const replacement = spawn(child, 'running');
  state.runtime[chat].turns = [{ id: 't', items: [replacement] }];
  answer({
    data: [{ id: 'ct', status: 'completed', items: [{ type: 'agentMessage', id: 'stale', text: 'old report' }] }],
    nextCursor: null,
  });
  await pending;
  assert.deepEqual(T.agentThread(chat, child).items, []);
  assert.equal(replacement.agentsStates[child].status, 'running');
  assert.equal(
    io.some((entry) => entry[0] === 'turns' && entry[1] === 'must-not-refresh'),
    false,
  );
});

test('stopping a shell cannot mark a replacement source stopped after its reply', async () => {
  const chat = 'switched-shell-stop';
  harness = 'codex';
  terminals = { data: [term('same-id')] };
  await P.pollCodexTasks(chat);
  const task = P.codexTasks(chat)[0];
  let answer!: (value: boolean) => void;
  terminate = new Promise((resolve) => (answer = resolve)) as any;
  const pending = P.stopCodexTask(chat, task);
  natives.set(chat, 'replacement');
  await P.pollCodexTasks(chat);
  answer(true);
  assert.equal(await pending, false);
  assert.equal(P.codexTasks(chat)[0].status, 'running');
  terminate = true;
});

test('a source switch during child discovery prevents an agent interruption', async () => {
  const chat = 'switched-agent-stop';
  harness = 'codex';
  let answer!: (value: any) => void;
  childPages['stop-child'] = new Promise((resolve) => (answer = resolve));
  io.length = 0;
  const pending = P.stopCodexTask(chat, { agentKey: 'stop-child' } as any);
  harness = 'claude';
  answer({ data: [{ id: 'ct', status: 'inProgress', items: [] }], nextCursor: null });
  assert.equal(await pending, false);
  assert.deepEqual(
    io.filter((entry) => entry[0] === 'request'),
    [],
  );
  harness = 'codex';
});

test('an agent stop reply or failure for a retired source cannot refresh or toast into its replacement', async () => {
  for (const fail of [false, true]) {
    const chat = `stop-reply-${fail}`;
    const child = `stop-reply-child-${fail}`;
    harness = 'codex';
    childPages[child] = { data: [{ id: 'ct', status: 'inProgress', items: [] }], nextCursor: null };
    let answer!: () => void;
    interruptWait = new Promise((resolve) => (answer = resolve));
    interruptFails = fail ? 'error' : false;
    io.length = 0;
    const calls = terminalCalls;
    const pending = P.stopCodexTask(chat, { agentKey: child } as any);
    await new Promise((resolve) => setImmediate(resolve));
    natives.set(chat, 'replacement');
    answer();
    assert.equal(await pending, false);
    assert.equal(terminalCalls, calls);
    assert.equal(
      io.some((entry) => entry[0] === 'toast'),
      false,
    );
  }
  interruptFails = false;
  interruptWait = null;
});

test('live child output and parent completion win over an older agent refresh', async () => {
  const chat = 'agent-live-during-refresh';
  const child = 'child-live-during-refresh';
  harness = 'codex';
  terminals = { data: [] };
  state.runtime[chat] = { loaded: true, turns: [{ id: 't', items: [spawn(child, 'running')] }] };
  let answer!: (value: any) => void;
  childPages[child] = new Promise((resolve) => (answer = resolve));
  const pending = P.pollCodexTasks(chat);
  await new Promise((resolve) => setImmediate(resolve));
  const live = {
    loaded: true,
    turns: [{ id: 'child-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'live', text: 'live report' }] }],
  };
  state.runtime[child] = live;
  A.codexAgentTurnsChanged(child, live.turns);
  const completed = { ...spawn(child, 'completed'), prompt: 'updated parent metadata' };
  state.runtime[chat].turns = [{ id: 't', items: [completed] }];
  answer({ data: [{ id: 'ct', status: 'failed', items: [{ type: 'agentMessage', id: 'stale', text: 'old report' }] }], nextCursor: null });
  await pending;
  assert.equal(T.agentThread(chat, child).items[0].id, 'live');
  assert.equal(state.runtime[chat].turns[0].items[0], completed);
});

test('an agent refresh can finish safely while its parent history is being reloaded', async () => {
  const chat = 'agent-parent-history-reload';
  const child = 'agent-with-reloaded-parent';
  harness = 'codex';
  terminals = { data: [] };
  const previous = spawn(child, 'running');
  state.runtime[chat] = { loaded: true, turns: [{ id: 't', items: [previous] }] };
  let answer!: (value: any) => void;
  childPages[child] = new Promise((resolve) => (answer = resolve));
  const pending = P.pollCodexTasks(chat);
  await new Promise((resolve) => setImmediate(resolve));
  delete state.runtime[chat];
  answer({ data: [{ id: 'ct', status: 'completed', items: [{ type: 'agentMessage', id: 'stored' }] }], nextCursor: null });
  await pending;
  assert.equal(T.agentThread(chat, child).items[0].id, 'stored');
  assert.equal(previous.agentsStates[child].status, 'running', 'a detached parent snapshot is not patched');
});

test('historical Codex agents retain their original owner and controls in an ACP chat', async () => {
  const chat = 'codex-agent-in-acp-chat';
  const child = 'historical-codex-child';
  harness = 'codex';
  natives.set(chat, 'acp:kimi:current');
  state.segments ??= {};
  state.segments[chat] = [
    { harness: 'codex', nativeId: 'old-parent', start: 0 },
    { harness: 'codex', nativeId: 'acp:kimi:current', start: 1 },
  ];
  state.runtime[chat] = {
    loaded: true,
    turns: [
      { id: 'old', items: [spawn(child, 'running')] },
      { id: 'new', items: [] },
    ],
  };
  childPages[child] = { data: [{ id: 'child-turn', status: 'inProgress', items: [] }], nextCursor: null };
  io.length = 0;
  await P.pollCodexTasks(chat);
  const task = P.codexTasks(chat)[0];
  assert.deepEqual(task.source, { kind: 'codex', key: 'old-parent' });
  assert.equal(task.stoppable, true);
  assert.ok(io.some((entry) => entry[0] === 'turns' && entry[1] === child));
  assert.equal(await P.stopCodexTask(chat, { ...task, description: 'UI-enriched historical task' }), true);
  assert.ok(io.some((entry) => entry[0] === 'request' && entry[2].threadId === child));
});

test('historical ACP agents stay unavailable to stop, and Claude history is left to main', async () => {
  const chat = 'historical-agent-families';
  harness = 'codex';
  terminals = { data: [] };
  const acp = {
    type: 'collabAgentToolCall',
    id: 'old-acp-call',
    agent: { key: 'old-acp-call', description: 'ACP work', status: 'running', transcript: 'full', toolUses: 0 },
  };
  const claude = {
    type: 'dynamicToolCall',
    id: 'old-claude-call',
    agent: { key: 'old-claude-call', description: 'Claude work', status: 'running', transcript: 'full', toolUses: 0 },
  };
  state.segments[chat] = [
    { harness: 'codex', nativeId: 'acp:kimi:old', start: 0 },
    { harness: 'claude', nativeId: 'claude:old', start: 1 },
    { harness: 'codex', nativeId: chat, start: 2 },
  ];
  state.runtime[chat] = {
    loaded: true,
    turns: [
      { id: 'acp', items: [acp] },
      { id: 'claude', items: [claude] },
      { id: 'new', items: [] },
    ],
  };
  await P.pollCodexTasks(chat);
  const [task] = P.codexTasks(chat);
  assert.equal(P.codexTasks(chat).length, 1);
  assert.deepEqual(task.source, { kind: 'acp', key: 'acp:kimi:old' });
  assert.equal(task.stoppable, false);
  assert.equal(await P.stopCodexTask(chat, task), false);
});

test('Codex agents remain polled when the current chat segment is Claude', async () => {
  const chat = 'codex-agent-in-claude-chat';
  const child = 'still-running-codex-child';
  harness = 'claude';
  natives.set(chat, 'claude:current');
  state.segments[chat] = [
    { harness: 'codex', nativeId: 'old-codex-parent', start: 0 },
    { harness: 'claude', nativeId: 'claude:current', start: 1 },
  ];
  state.runtime[chat] = {
    loaded: true,
    turns: [
      { id: 'old', items: [spawn(child, 'running')] },
      { id: 'new', items: [] },
    ],
  };
  state.runtime[child] = { loaded: true, turns: [{ id: 'child-turn', status: 'inProgress', items: [] }] };
  const calls = terminalCalls;
  assert.equal(P.shouldPollTasks(chat), true);
  await P.pollCodexTasks(chat);
  assert.equal(terminalCalls, calls, 'Claude has no current Codex terminal list to read');
  assert.deepEqual(P.codexTasks(chat)[0].source, { kind: 'codex', key: 'old-codex-parent' });
  assert.equal(P.codexTasks(chat)[0].status, 'running');
  harness = 'codex';
});

test('a Claude-only task history remains main-driven without adapter polling', async () => {
  const chat = 'claude-only-history';
  harness = 'claude';
  state.runtime[chat] = { turns: [{ items: [{ type: 'dynamicToolCall', agent: { key: 'claude-job', status: 'running' } }] }] };
  assert.equal(P.shouldPollTasks(chat), false);
  const calls = terminalCalls;
  await P.pollCodexTasks(chat);
  assert.equal(terminalCalls, calls);
  harness = 'codex';
});

test('unrecognized child-turn status never settles an agent through an inherited table key', async () => {
  harness = 'codex';
  blocked = null;
  terminals = { data: [] };
  for (const [i, status] of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].entries()) {
    const chat = `reserved-status-parent-${i}`;
    const child = `reserved-status-child-${i}`;
    state.runtime[chat] = { loaded: true, turns: [{ id: 't', items: [spawn(child, 'running')] }] };
    childPages[child] = { data: [{ id: 'ct', status, items: [] }], nextCursor: null };
    A.trackCodexAgent(chat, child);
    await P.pollCodexTasks(chat);
    assert.equal(state.runtime[chat].turns[0].items[0].agentsStates[child].status, 'running');
  }
});
