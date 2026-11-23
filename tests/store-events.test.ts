// src/store/store.ts: Codex item events from main and the app-server notifications they carry.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const chats = await import('../src/store/chats.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const item = (e: any) => (listeners['codex.onItem'](e), mock.timers.tick(100)); // a frame passes: display deltas are joined per frame
const note = (method: string, params: any) => item({ kind: 'notification', chatId: params.threadId ?? null, method, params });
const turns = (id: string) => st().runtime[id]?.turns ?? [];
const { splitTurn } = await import('../src/lib/asyncQuestions.ts');

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('the model change note names the model as the picker does, listed or not', () => {
  set({
    models: [{ model: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol' }] as any,
    chatConfig: { c: { model: 'gpt-6.1-sol' } },
    threads: { c: { id: 'c', preview: '', recencyAt: 1 } as any },
  });
  chats.setLastModel('c', 'old');
  item({ kind: 'turnStarting', chatId: 'c', clientId: 'k1', text: 'hello', attachments: [], opts: {}, mine: true });
  assert.equal((turns('c').at(-1)!.items[0] as any).text, 'Model changed to GPT-6.1 Sol');
  set({ chatConfig: { c: { model: 'gpt-6.1-luna' } } });
  item({ kind: 'turnStarting', chatId: 'c', clientId: 'k2', text: 'more', attachments: [], opts: {}, mine: true });
  assert.equal((turns('c').at(-1)!.items[0] as any).text, 'Model changed to GPT-6.1 Luna');
});

test('an Automatic model change note follows the recommendation rather than a stale receipt or global pin', () => {
  set({
    models: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true }] as any,
    config: { model: 'gpt-6.1-sol' },
    prefs: { ...st().prefs, model: 'gpt-6.1-sol' },
    chatConfig: { c: { model: null } },
    runtime: { c: { settings: { model: 'gpt-6.1-sol' }, turns: [] } as any },
    threads: { c: { id: 'c', preview: '', recencyAt: 1 } as any },
  });
  chats.setLastModel('c', 'gpt-6.1-sol');
  item({ kind: 'turnStarting', chatId: 'c', clientId: 'automatic', text: 'continue', attachments: [], opts: {}, mine: true });
  assert.equal((turns('c').at(-1)!.items[0] as any).text, 'Model changed to GPT-6.2 Sol');
});

test('a message shows at once in a pending turn, with a model change note, then takes the turn id Codex gives it', () => {
  set({
    models: [{ model: 'gpt-5', displayName: 'GPT-5' }] as any,
    chatConfig: { c: { model: 'gpt-5' } },
    threads: { c: { id: 'c', preview: '', recencyAt: 1 } as any },
    threadOrder: ['x', 'c'],
  });
  chats.setLastModel('c', 'old');
  item({ kind: 'turnStarting', chatId: 'c', clientId: 'k1', text: 'hello', attachments: [], opts: { plan: true }, mine: true });
  let t = turns('c')[0];
  assert.deepEqual([t.id, t.planMode, t.items.map((i: any) => i.type)], ['pending-k1', true, ['statusNote', 'userMessage']]);
  assert.equal((t.items[0] as any).text, 'Model changed to GPT-5');
  assert.equal(st().runtime.c.activeTurnId, 'pending-k1');
  item({ kind: 'turnStarted', chatId: 'c', clientId: 'k1', turnId: 'T1', text: 'hello' });
  t = turns('c')[0];
  assert.equal(t.id, 'T1');
  assert.equal(st().runtime.c.activeTurnId, 'T1');
  assert.deepEqual(st().threadOrder, ['c', 'x']);
  assert.ok(st().threads.c.recencyAt! > 1);
  assert.equal(st().threads.c.recencyAt, st().threads.c.updatedAt);
  assert.equal((st().threads.c as any).preview, 'hello');
  // a note given by main wins; the model falls back through settings, prefs and config
  set({ chatConfig: {}, runtime: { ...st().runtime, d: { settings: { model: 'run-model' }, turns: [] } as any } });
  item({
    kind: 'turnStarting',
    chatId: 'd',
    clientId: 'k2',
    text: 'x',
    attachments: [],
    opts: { note: { kind: 'switch', text: 'Switched' } },
  });
  assert.equal((turns('d')[0].items[0] as any).text, 'Switched');
  set({ prefs: { ...st().prefs, model: null }, config: { model: 'cfg' } });
  item({ kind: 'turnStarting', chatId: 'e', clientId: 'k3', text: 'x', attachments: [], opts: {} });
  item({ kind: 'turnStarting', chatId: 'e2', clientId: 'k3', text: 'x', attachments: [], opts: { model: 'm' } });
  set({
    config: null,
    runtime: { ...st().runtime, f: { turns: [], tokenUsage: { modelContextWindow: 400_000, last: { inputTokens: 1 } } } as any },
  });
  item({ kind: 'turnStarting', chatId: 'f', clientId: 'k4', text: 'x', attachments: [], opts: {} });
  assert.deepEqual(
    turns('f')[0].items.map((i: any) => i.type),
    ['userMessage'],
  );
  // the optimistic turn after earlier ones takes its id
  item({ kind: 'turnStarted', chatId: 'f', clientId: 'k4', turnId: 'F', text: 'x' });
  item({ kind: 'turnStarting', chatId: 'f', clientId: 'k5', text: 'y', attachments: [], opts: {} });
  item({ kind: 'turnStarted', chatId: 'f', clientId: 'k5', turnId: 'F2', text: 'y' });
  assert.deepEqual(
    turns('f').map((t) => t.id),
    ['F', 'F2'],
  );
});

test('turnStarted after the notification already brought the turn: the optimistic copy merges into it', () => {
  item({ kind: 'turnStarting', chatId: 'g', clientId: 'k', text: 'hi', attachments: [], opts: {} });
  S.patchRuntime('g', (r) => ({
    turns: [...r.turns, { ...S.newTurn('T'), items: [{ type: 'agentMessage', id: 'a' } as any] }],
    activeTurnId: 'other',
  }));
  item({ kind: 'turnStarted', chatId: 'g', clientId: 'k', turnId: 'T', text: 'hi' });
  assert.deepEqual(
    turns('g').map((t) => [t.id, t.items.map((i: any) => i.type)]),
    [['T', ['userMessage', 'agentMessage']]],
  );
  assert.equal(st().runtime.g.activeTurnId, 'other');
  // with its user message already there, or no optimistic turn: nothing added
  S.patchRuntime('h', () => ({ turns: [{ ...S.newTurn('U'), items: [{ type: 'userMessage', id: 'u' } as any] }] }));
  item({ kind: 'turnStarted', chatId: 'h', clientId: 'none', turnId: 'U', text: '' });
  assert.equal(turns('h')[0].items.length, 1);
  S.patchRuntime('h2', () => ({ turns: [{ ...S.newTurn('U'), items: [] }] }));
  item({ kind: 'turnStarted', chatId: 'h2', clientId: 'none', turnId: 'U', text: '' });
  assert.equal(turns('h2')[0].items.length, 0);
  // a temporary chat stays out of the sidebar
  set({ threads: { eph: { id: 'eph', ephemeral: true, preview: 'kept' } as any }, threadOrder: ['a'] });
  item({ kind: 'turnStarted', chatId: 'eph', clientId: 'z', turnId: 'Z', text: 'new' });
  assert.deepEqual(st().threadOrder, ['a']);
  assert.equal((st().threads.eph as any).preview, 'kept');
});

test('turnFailed, steered, goal bubbles and goal failures', async () => {
  item({ kind: 'turnStarting', chatId: 'i', clientId: 'k', text: 'x', attachments: [], opts: {} });
  item({ kind: 'turnFailed', chatId: 'i', clientId: 'k', error: 'no quota' });
  assert.deepEqual([turns('i')[0].status, turns('i')[0].error], ['failed', { message: 'no quota' }]);
  assert.equal(st().runtime.i.activeTurnId, null);
  S.patchRuntime('i', () => ({ activeTurnId: 'keep' }));
  item({ kind: 'turnFailed', chatId: 'i', clientId: 'other', error: 'x' });
  assert.equal(st().runtime.i.activeTurnId, 'keep');
  // the turn is over: the steer's message is already in it (see the steer race test below)
  item({ kind: 'steered', chatId: 'i', turnId: 'pending-k', text: 'also', attachments: [], clientId: 's' });
  assert.equal(turns('i')[0].items.length, 1);
  // a goal with no turn running: a pending turn of its own; a failure drops it
  item({ kind: 'goalStarting', chatId: 'j', clientId: 'g1', objective: 'ship it' });
  assert.equal(st().runtime.j.activeTurnId, 'pending-g1');
  item({ kind: 'goalFailed', chatId: 'j', clientId: 'g1' });
  assert.deepEqual([turns('j'), st().runtime.j.activeTurnId], [[], null]);
  // with a turn running: the bubble joins it, and a failure takes only the bubble
  S.patchRuntime('j', () => ({
    turns: [
      { ...S.newTurn('R'), items: [{ type: 'agentMessage', id: 'a' } as any] },
      { ...S.newTurn('S'), items: [] },
    ],
    activeTurnId: 'R',
  }));
  item({ kind: 'goalStarting', chatId: 'j', clientId: 'g2', objective: 'more' });
  assert.equal(turns('j')[0].items.length, 2);
  item({ kind: 'goalFailed', chatId: 'j', clientId: 'g2' });
  assert.deepEqual(
    turns('j')[0].items.map((i: any) => i.id),
    ['a'],
  );
  assert.equal(st().runtime.j.activeTurnId, 'R');
  // goal state goes to main's session
  item({ kind: 'goal', chatId: 'j', goal: { objective: 'o', status: 'active' } });
  item({ kind: 'goal', chatId: 'j' });
  await flush();
  assert.deepEqual(
    callsOf('session.patch').map(([, p]) => p.goal?.status ?? null),
    ['active', null],
  );
});

test('a steer whose answer comes after the turn ended: the message shows once and the reply stays the answer', () => {
  const user = (id: string, clientId: string | null, text: string) => ({
    type: 'userMessage',
    id,
    clientId,
    content: [{ type: 'text', text, text_elements: [] }],
  });
  const agent = (id: string, text: string) => ({
    type: 'agentMessage',
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  const done = (chat: string, it: any) => (
    note('item/started', { threadId: chat, turnId: 'T', item: it }), note('item/completed', { threadId: chat, turnId: 'T', item: it })
  );
  const shown = (chat: string, text: string) =>
    turns(chat)[0].items.filter((i: any) => i.type === 'userMessage' && i.content[0].text === text).length;
  const race = (chat: string, clientId: string | null) => {
    item({ kind: 'turnStarting', chatId: chat, clientId: 'k', text: 'take it SLOW', attachments: [], opts: {} });
    item({ kind: 'turnStarted', chatId: chat, clientId: 'k', turnId: 'T', text: 'take it SLOW' });
    done(chat, user('u1', 'k', 'take it SLOW'));
    done(chat, agent('a1', 'fake-codex: take it SLOW'));
    // main passes on the app-server's notifications before it handles the answer to turn/steer
    const steered = [user('u2', clientId, 'also check the docs'), agent('a2', 'fake-codex: also check the docs')];
    for (const it of steered) done(chat, it);
    note('turn/completed', {
      threadId: chat,
      turn: {
        id: 'T',
        status: 'completed',
        items: [user('u1', 'k', 'take it SLOW'), agent('a1', 'fake-codex: take it SLOW'), ...steered],
        itemsView: 'full',
      },
    });
    item({ kind: 'steered', chatId: chat, turnId: 'T', text: 'also check the docs', attachments: [], clientId: 'c2' });
  };
  race('race', 'c2');
  assert.equal(shown('race', 'also check the docs'), 1);
  assert.equal((splitTurn(turns('race')[0].items, false).final as any)?.text, 'fake-codex: also check the docs');
  // an app-server that doesn't give the id back: the finished turn already has the message
  race('race-old', null);
  assert.equal(shown('race-old', 'also check the docs'), 1);
  assert.equal((splitTurn(turns('race-old')[0].items, false).final as any)?.text, 'fake-codex: also check the docs');

  // while the turn runs: whichever comes first, the message shows once
  item({ kind: 'turnStarting', chatId: 'run', clientId: 'k', text: 'go', attachments: [], opts: {} });
  item({ kind: 'turnStarted', chatId: 'run', clientId: 'k', turnId: 'T', text: 'go' });
  item({ kind: 'steered', chatId: 'run', turnId: 'T', text: 'first', attachments: [], clientId: 'c3' });
  assert.equal(turns('run')[0].items.at(-1)!.id, 'local-steer-c3');
  done('run', user('u3', 'c3', 'first'));
  done('run', user('u4', 'c4', 'second'));
  item({ kind: 'steered', chatId: 'run', turnId: 'T', text: 'second', attachments: [], clientId: 'c4' });
  assert.deepEqual(
    turns('run')[0].items.map((i: any) => i.id),
    ['local-k', 'u3', 'u4'],
  );
});

test('locked and leaseLocked: another Codex client has the chat', () => {
  set({ elsewhere: { l: { app: 'codex', running: true, hard: false } } });
  item({ kind: 'locked', chatId: 'l', item: { text: 'q', attachments: [], opts: { plan: true } } });
  assert.deepEqual(st().elsewhere.l, { app: 'codex', running: true, hard: true });
  assert.deepEqual(st().runtime.l.held, { text: 'q', attachments: [], opts: { plan: true } });
  item({ kind: 'leaseLocked', chatId: 'm' });
  assert.deepEqual(st().elsewhere.m, { app: 'codex', running: false, hard: true });
  set({ elsewhere: { m: { app: 'codex', running: true, hard: false } } });
  item({ kind: 'leaseLocked', chatId: 'm' });
  assert.equal(st().elsewhere.m.running, true);
  assert.match(st().toasts[0].text, /open in another Codex app/);
});

test('scheduled runs, names, toasts, switches, negotiation and requests', () => {
  set({ prefs: { ...st().prefs, hiddenFolders: ['/w'] } });
  item({ kind: 'chatStarted', chatId: 'r1', cwd: '/w', worktreeOf: '/repo', config: { model: 'm', effort: null, serviceTier: null } });
  item({ kind: 'chatStarted', chatId: 'r2', cwd: '/v', worktreeOf: null, config: { model: null, effort: null, serviceTier: null } });
  assert.deepEqual(st().prefs.hiddenFolders, []);
  assert.deepEqual(st().worktreeOf, { r1: '/repo' });
  assert.equal(st().chatConfig.r1.model, 'm');
  assert.equal(st().runtime.r2.loaded, true);
  set({ threads: { n: { id: 'n' } as any } });
  item({ kind: 'threadName', chatId: 'n', name: 'Named' });
  item({ kind: 'threadName', chatId: 'none', name: 'x' });
  assert.equal((st().threads.n as any).name, 'Named');
  assert.equal(st().threads.none, undefined);
  item({ kind: 'toast', level: 'error', text: 'hey' });
  assert.deepEqual(
    st().toasts.map((t) => [t.text, t.kind]),
    [['hey', 'error']],
  );
  item({ kind: 'switched', chatId: 's', harness: 'claude', key: 'k', model: 'opus', fresh: true });
  item({ kind: 'switched', chatId: 's', harness: 'codex', key: 'k2', model: 'gpt', fresh: false });
  assert.deepEqual(callsOf('claude.markNewClaudeSession'), [['k']]);
  assert.deepEqual(st().runtime.s.settings, { model: 'gpt', effort: null });
  item({ kind: 'negotiated', negotiated: { cliVersion: '2' } });
  assert.deepEqual(st().codexCompat, { cliVersion: '2' });
  // an approval card comes from main's session, not the request event
  item({ kind: 'request', chatId: 'x', request: { id: 1, method: 'm', params: {} } });
  item({ kind: 'unknown' });
  assert.deepEqual(st().pending, []);
});

test('thread notifications: started, status, names, archive, projects, token usage and goals', async () => {
  note('thread/started', { thread: { id: 'a', name: 'A' } });
  note('thread/started', { thread: { id: 'tmp', ephemeral: true } });
  note('thread/started', {});
  assert.deepEqual(st().threadOrder, ['a']);
  note('thread/status/changed', { threadId: 'a', status: { type: 'active' } });
  note('thread/status/changed', { threadId: 'zz', status: { type: 'active' } });
  assert.deepEqual((st().threads.a as any).status, { type: 'active' });
  note('thread/name/updated', { threadId: 'a', threadName: 'Named' });
  assert.equal((st().threads.a as any).name, 'Named');
  note('thread/name/updated', { threadId: 'a', name: 'Other' });
  assert.equal((st().threads.a as any).name, 'Other');
  note('thread/name/updated', { threadId: 'zz', name: 'x' });
  note('thread/project/updated', { threadId: 'a', projectId: 'p' });
  assert.equal((st().threads.a as any).projectId, 'p');
  note('thread/project/updated', { threadId: 'a' });
  assert.equal((st().threads.a as any).projectId, null);
  note('thread/project/updated', { threadId: 'zz' });
  assert.equal(st().threads.zz, undefined);
  note('thread/archived', { threadId: 'a' });
  assert.deepEqual(st().threadOrder, []);
  note('thread/deleted', { threadId: 'a' });
  impl['api.threadList'] = async () => ({ data: [{ id: 'back' }], nextCursor: null });
  note('thread/unarchived', { threadId: 'back' });
  set({ conn: 'ready' });
  note('project/changed', {});
  await flush();
  assert.deepEqual(st().threadOrder, ['back']);
  assert.equal(callsOf('api.projectList').length, 1);
  note('thread/tokenUsage/updated', { threadId: 'a', tokenUsage: { total: 1 } });
  assert.deepEqual(st().runtime.a.tokenUsage, { total: 1 });
  note('thread/goal/updated', { threadId: 'a', goal: { status: 'active' } });
  note('thread/goal/cleared', { threadId: 'a' });
  await flush();
  assert.deepEqual(
    callsOf('session.patch').map(([, p]) => p.goal),
    [{ status: 'active' }, null],
  );
});

test('item notifications: started, completed and updated items, replacing the optimistic message', () => {
  item({ kind: 'turnStarting', chatId: 'p', clientId: 'c1', text: 'x', attachments: [], opts: {} });
  S.patchRuntime('p', () => ({ turns: [{ ...turns('p')[0], id: 'T' }] }));
  note('item/started', { threadId: 'p', turnId: 'T', item: { id: 'u1', type: 'userMessage', clientId: 'c1' }, startedAtMs: 5 });
  assert.deepEqual(
    turns('p')[0].items.map((i) => i.id),
    ['u1'],
  );
  assert.equal(turns('p')[0].itemTimes.u1.start, 5);
  note('item/started', { threadId: 'p', turnId: 'T', item: { id: 'u2', type: 'userMessage' } });
  note('item/started', { threadId: 'p', turnId: 'T', item: { id: 'u2', type: 'agentMessage' } });
  assert.deepEqual(
    turns('p')[0].items.map((i) => i.id),
    ['u1', 'u2'],
  );
  note('item/updated', { threadId: 'p', turnId: 'T', item: { id: 'u2', type: 'agentMessage', text: 'upd' } });
  note('item/updated', { threadId: 'p', turnId: 'T', item: { id: 'n1', type: 'agent' } });
  assert.deepEqual(
    turns('p')[0].items.map((i: any) => i.text ?? i.id),
    ['u1', 'upd', 'n1'],
  );
  note('item/completed', { threadId: 'p', turnId: 'T', item: { id: 'u2', type: 'agentMessage', text: 'done' } });
  note('item/completed', { threadId: 'p', turnId: 'T', item: { id: 'c9', type: 'commandExecution' } });
  assert.deepEqual(
    turns('p')[0].items.map((i: any) => i.text ?? i.id),
    ['u1', 'done', 'n1', 'c9'],
  );
  assert.ok(turns('p')[0].itemTimes.c9.end);
  // a completed user message replaces its optimistic copy, matched by id or client id
  item({ kind: 'turnStarting', chatId: 'q', clientId: 'c2', text: 'x', attachments: [], opts: {} });
  note('item/completed', { threadId: 'q', turnId: 'pending-c2', item: { id: 'real', type: 'userMessage', clientId: 'c2' } });
  assert.deepEqual(
    turns('q')[0].items.map((i) => i.id),
    ['real'],
  );
  note('item/completed', { threadId: 'q', turnId: 'pending-c2', item: { id: 'real', type: 'userMessage', text: 'again' } });
  assert.deepEqual(
    turns('q')[0].items.map((i: any) => i.text ?? i.id),
    ['again'],
  );
  note('item/completed', { threadId: 'q', turnId: 'pending-c2', item: { id: 'u5', type: 'userMessage', clientId: 'other' } });
  assert.deepEqual(
    turns('q')[0].items.map((i) => i.id),
    ['real', 'u5'],
  );
  note('item/completed', { threadId: 'q', turnId: 'pending-c2', item: { id: 'u6', type: 'userMessage' } });
  assert.equal(turns('q')[0].items.length, 3);
});

test('streamed deltas build their items, and model output ends a retry banner', () => {
  const T = { threadId: 's', turnId: 'T' };
  S.patchRuntime('s', () => ({ activeTurnId: 'T', retry: 'Reconnecting… 1/5' }));
  note('item/commandExecution/outputDelta', { ...T, itemId: 'cmd', delta: 'x' });
  assert.equal(st().runtime.s.retry, 'Reconnecting… 1/5');
  note('item/agentMessage/delta', { ...T, itemId: 'm', delta: 'Hel' });
  assert.equal(st().runtime.s.retry, null);
  note('item/agentMessage/delta', { ...T, itemId: 'm', delta: 'lo' });
  note('item/plan/delta', { ...T, itemId: 'p', delta: 'step' });
  note('item/reasoning/summaryPartAdded', { ...T, itemId: 'r', summaryIndex: 1 });
  note('item/reasoning/summaryTextDelta', { ...T, itemId: 'r', summaryIndex: 1, delta: 'think' });
  note('item/reasoning/summaryTextDelta', { ...T, itemId: 'r2', summaryIndex: 0, delta: 'a' });
  note('item/reasoning/textDelta', { ...T, itemId: 'r', delta: 'raw' });
  note('item/reasoning/textDelta', { ...T, itemId: 'r', contentIndex: 2, delta: 'z' });
  const by = (id: string) => turns('s')[0].items.find((i) => i.id === id) as any;
  assert.equal(by('m').text, 'Hello');
  assert.equal(by('p').text, 'step');
  assert.deepEqual(by('r').summary, ['', 'think']);
  assert.deepEqual(by('r').content, ['raw', '', 'z']);
  assert.deepEqual(by('r2').summary, ['a']);
  // patches on items that exist (or without fields yet)
  S.patchTurn('s', 'T', (t) => ({
    items: [
      ...t.items,
      { id: 'bare', type: 'agentMessage' } as any,
      { id: 'rb', type: 'reasoning' } as any,
      { id: 'c', type: 'commandExecution' } as any,
    ],
  }));
  note('item/agentMessage/delta', { ...T, itemId: 'bare', delta: 'b' });
  note('item/plan/delta', { ...T, itemId: 'bare', delta: 'c' });
  S.patchTurn('s', 'T', (t) => ({ items: [...t.items, { id: 'pb', type: 'plan' } as any, { id: 'u', type: 'userMessage' } as any] }));
  note('item/plan/delta', { ...T, itemId: 'pb', delta: 'p' });
  assert.equal(by('pb').text, 'p');
  note('item/reasoning/summaryPartAdded', { ...T, itemId: 'rb', summaryIndex: 0 });
  note('item/reasoning/summaryTextDelta', { ...T, itemId: 'rb', summaryIndex: 0, delta: 's' });
  S.patchTurn('s', 'T', (t) => ({ items: [...t.items, { id: 'rc', type: 'reasoning' } as any, { id: 'rd', type: 'reasoning' } as any] }));
  note('item/reasoning/textDelta', { ...T, itemId: 'rc', delta: 't' });
  note('item/reasoning/summaryTextDelta', { ...T, itemId: 'rd', summaryIndex: 0, delta: 'q' });
  note('item/commandExecution/outputDelta', { ...T, itemId: 'c', delta: 'out' });
  note('item/commandExecution/outputDelta', { ...T, itemId: 'c', delta: '2' });
  note('item/fileChange/patchUpdated', { ...T, itemId: 'c', changes: [{ path: 'a' }] });
  note('item/fileChange/patchUpdated', { ...T, itemId: 'c' });
  note('item/mcpToolCall/progress', { ...T, itemId: 'c', message: 'half' });
  assert.equal(by('bare').text, 'bc');
  assert.deepEqual(by('rb').summary, ['s']);
  assert.deepEqual(by('rc').content, ['t']);
  assert.deepEqual(by('rd').summary, ['q']);
  assert.deepEqual([by('c').aggregatedOutput, by('c').changes, by('c').progress], ['out2', [{ path: 'a' }], 'half']);
  note('turn/plan/updated', { ...T, explanation: 'why', plan: [{ step: 'a' }] });
  note('turn/diff/updated', { ...T, diff: '+x' });
  assert.deepEqual([turns('s')[0].plan, turns('s')[0].diff], [{ explanation: 'why', steps: [{ step: 'a' }], steered: 0 }, '+x']);
});

test('errors, retries, account and config notices (a sign-in ending: tests/codexLoginCompleted.test.ts)', async () => {
  note('error', { threadId: 'e', turnId: 'T', willRetry: true, error: { message: 'Reconnecting 2/5' } });
  assert.equal(st().runtime.e.retry, 'Reconnecting 2/5');
  note('error', { threadId: 'e', turnId: 'T', willRetry: true });
  assert.equal(st().runtime.e.retry, 'Reconnecting…');
  note('error', { threadId: 'e', turnId: 'T', willRetry: false, error: { message: 'dead' } });
  assert.deepEqual([st().runtime.e.retry, turns('e')[0].error], [null, { message: 'dead' }]);
  note('serverRequest/resolved', {});
  note('account/updated', {});
  note('configWarning', { summary: 'bad key' });
  note('deprecationNotice', { summary: 'bad key', details: 'more' });
  note('deprecationNotice', { summary: 'old flag', details: 'd' });
  assert.deepEqual(st().configWarnings, [
    { summary: 'bad key', details: null },
    { summary: 'old flag', details: 'd' },
  ]);
  note('account/rateLimits/updated', { rateLimits: { primary: 1 } });
  set({ rateLimits: { credits: 2 } as any });
  note('account/rateLimits/updated', { rateLimits: { primary: 3 } });
  assert.deepEqual(st().rateLimits, { credits: 2, rateLimits: { primary: 3 } });
  note('account/login/completed', { success: true });
  note('thread/compacted', { threadId: 'e' });
  note('model/rerouted', { toModel: 'mini' });
  note('model/rerouted', {});
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['Signed in', 'Context compacted', 'Model rerouted to mini', 'Model rerouted to another model'],
  );
  let fired = 0;
  (globalThis as any).window.addEventListener('skills-changed', () => fired++);
  note('skills/changed', {});
  assert.equal(fired, 1);
  const warn = mock.method(console, 'warn', () => {});
  note('warning', { summary: 's' });
  note('warning', { message: 'm' });
  note('warning', {});
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments),
    [
      ['warning', 's'],
      ['warning', 'm'],
    ],
  );
  warn.mock.restore();
  await flush();
  assert.ok(callsOf('api.accountRead').length >= 2);
  // applyNotification is the same path for other harnesses' translators
  S.applyNotification('thread/started', { thread: { id: 'via' } });
  assert.ok(st().threads.via);
});

test('malformed text deltas cannot throw, create items, or clear model retry state', () => {
  const threadId = 'invalid-delta';
  const turnId = 'T';
  S.patchRuntime(threadId, () => ({ activeTurnId: turnId, retry: 'Reconnecting' }));
  for (const method of [
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
  ]) {
    for (const delta of [undefined, null, 42, false, [], { toString: 'not callable', valueOf: null }]) {
      assert.doesNotThrow(() => note(method, { threadId, turnId, itemId: 'i', summaryIndex: 0, contentIndex: 0, delta }));
      assert.equal(st().runtime[threadId].retry, 'Reconnecting');
      assert.deepEqual(turns(threadId), []);
    }
  }
  note('item/agentMessage/delta', { threadId, turnId, itemId: 'i', delta: 'Kept' });
  assert.equal(st().runtime[threadId].retry, null);
  assert.equal((turns(threadId)[0].items[0] as any).text, 'Kept');
});

test('invalid reasoning indices cannot create items or clear model retry state', () => {
  for (const [method, field] of [
    ['item/reasoning/summaryPartAdded', 'summaryIndex'],
    ['item/reasoning/summaryTextDelta', 'summaryIndex'],
    ['item/reasoning/textDelta', 'contentIndex'],
  ]) {
    for (const index of [-1, 0.5, '0', false, [], {}, 4096, 4294967295]) {
      const threadId = 'invalid-index';
      S.patchRuntime(threadId, () => ({ activeTurnId: 'T', retry: 'Reconnecting' }));
      assert.doesNotThrow(() => note(method, { threadId, turnId: 'T', itemId: 'r', [field]: index, delta: 'lost' }));
      assert.equal(st().runtime[threadId].retry, 'Reconnecting');
      assert.deepEqual(turns(threadId), []);
    }
  }
});

test('valid reasoning indices preserve gaps, the last admitted part, and raw-content defaults', () => {
  const T = { threadId: 'index-boundary', turnId: 'T', itemId: 'r' };
  note('item/reasoning/summaryPartAdded', { ...T, summaryIndex: 4095 });
  note('item/reasoning/summaryTextDelta', { ...T, summaryIndex: 4095, delta: 'last' });
  note('item/reasoning/textDelta', { ...T, contentIndex: null, delta: 'first' });
  note('item/reasoning/textDelta', { ...T, contentIndex: 4095, delta: 'last' });
  const r = turns(T.threadId)[0].items[0] as any;
  assert.equal(r.summary.length, 4096);
  assert.equal(r.summary[0], '');
  assert.equal(r.summary[4095], 'last');
  assert.equal(r.content.length, 4096);
  assert.equal(r.content[0], 'first');
  assert.equal(r.content[4095], 'last');
});
