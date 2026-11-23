// Stop on a Codex chat ends the commands the stopped turn started, as Stop does on Claude Code (#1940): the CodexAdapter
// keeps each turn's running command items (electron/harness/codexTurnCommands.cjs) and, once the app-server accepts
// turn/interrupt, terminates their background terminals. Earlier turns' terminals keep running. The app-server is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { CodexTurnCommands, stopTurnCommands, STOP_COMMANDS_MS } = require('../electron/harness/codexTurnCommands.cjs');

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

type Handler = (p: any) => any;
/** An app-server stand-in: each request answers from `handlers` (a throw answers with that error). */
function setup(handlers: Record<string, Handler> = {}, native: string[] = []) {
  const sent: any[] = [];
  const listeners = new Set<(e: any) => void>();
  const emit = (e: any) => {
    for (const l of listeners) l(e);
  };
  const all: Record<string, Handler> = {
    initialize: () => ({ userAgent: 'fake', codexHome: '/h' }),
    'turn/interrupt': () => ({}),
    'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
    'mcpServer/tool/call': () => ({ content: [] }),
    ...handlers,
  };
  const server = {
    listeners,
    proc: {},
    start() {},
    send(m: any) {
      sent.push(m);
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        try {
          const h = all[m.method];
          emit({ kind: 'message', msg: { id: m.id, result: h ? h(m.params) : {} } });
        } catch (e: any) {
          emit({ kind: 'message', msg: { id: m.id, error: { code: e.code ?? -32600, message: e.message } } });
        }
      });
    },
  };
  const events: any[] = [];
  const nat = new Set(native);
  const a = new CodexAdapter({
    server,
    state: new SessionStore(),
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat, key: chat }),
    chatOf: (nid: string) => nid,
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit: (e: any) => events.push(e),
    tools: { outgoing: (m: any) => m, observe() {}, exited() {}, setUserServers() {}, isNativeThread: (id: string) => nat.has(id) },
    probe: null,
    log: () => {},
    onStopped: () => {},
  });
  const notify = (method: string, params: any) => emit({ kind: 'message', msg: { method, params } });
  const started = (turnId: string, id: string, threadId = 'th') =>
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id, command: 'x', status: 'inProgress' } });
  const methods = () => sent.filter((m) => m.method && m.method !== 'initialize' && m.method !== 'initialized').map((m) => m.method);
  const terminated = () => sent.filter((m) => m.method === 'thread/backgroundTerminals/terminate').map((m) => m.params);
  const toasts = () => events.filter((e) => e.kind === 'toast').map((e) => e.text);
  return { a, notify, started, methods, terminated, toasts, sent, events };
}
const row = (itemId: string, processId: string, command = `cmd ${processId}`) => ({ itemId, processId, command, cwd: '/', osPid: 1 });

test("Stop ends the stopped turn's running commands and leaves an earlier turn's background terminal", async () => {
  const s = setup({
    'thread/backgroundTerminals/list': () => ({ data: [row('old', 'p0'), row('own', 'p1'), row('done', 'p2')] }),
  });
  s.started('T0', 'old');
  s.notify('turn/completed', { threadId: 'th', turn: { id: 'T0', status: 'completed' } });
  s.started('T1', 'own');
  s.started('T1', 'done');
  s.notify('item/completed', { threadId: 'th', turnId: 'T1', item: { type: 'commandExecution', id: 'done', status: 'completed' } });
  assert.deepEqual(await s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' }), {});
  await settle();
  assert.deepEqual(s.methods(), ['turn/interrupt', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate']);
  assert.deepEqual(s.terminated(), [{ threadId: 'th', processId: 'p1' }]);
  assert.equal(s.sent.find((m) => m.method === 'thread/backgroundTerminals/list').params.threadId, 'th');
  assert.deepEqual(s.toasts(), []);
  // its completion reaches the windows cut off, once; another command's does not
  const done = (id: string) => ({ threadId: 'th', turnId: 'T1', item: { type: 'commandExecution', id, status: 'failed', exitCode: -1 } });
  s.notify('item/completed', done('own'));
  s.notify('item/completed', done('own'));
  s.notify('item/completed', done('old'));
  await settle();
  assert.deepEqual(
    s.events
      .filter((e) => e.method === 'item/completed' && e.params.item.id !== 'done')
      .map((e) => [e.params.item.id, e.params.item.cutOff ?? false]),
    [
      ['own', true],
      ['own', false],
      ['old', false],
    ],
  );
});

test("the stopped turn's turn/completed arriving before the interrupt's answer still ends its commands", async () => {
  let s: ReturnType<typeof setup>;
  s = setup({
    'turn/interrupt': () => {
      s.notify('turn/completed', { threadId: 'th', turn: { id: 'T1', status: 'interrupted' } });
      return {};
    },
    'thread/backgroundTerminals/list': () => ({ data: [row('own', 'p1')] }),
  });
  s.started('T1', 'own');
  await s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  await settle();
  assert.deepEqual(s.terminated(), [{ threadId: 'th', processId: 'p1' }]);
});

test('a native thread stops its commands the same way, after its own fast Stop', async () => {
  const s = setup({ 'thread/backgroundTerminals/list': () => ({ data: [row('own', 'p1')] }) }, ['nat']);
  s.started('T1', 'own', 'nat');
  await s.a.request('turn/interrupt', { threadId: 'nat', turnId: 'T1' });
  await settle();
  assert.equal(s.methods()[0], 'turn/interrupt');
  assert.deepEqual(s.terminated(), [{ threadId: 'nat', processId: 'p1' }]);
});

test('no running command, another turn, or a refused interrupt reads no list and ends nothing', async () => {
  const s = setup({ 'thread/backgroundTerminals/list': () => ({ data: [row('own', 'p1')] }) });
  await s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  s.started('T2', 'own');
  await s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  await settle();
  assert.deepEqual(s.methods(), ['turn/interrupt', 'turn/interrupt']);

  const refused = setup({
    'turn/interrupt': () => {
      throw new Error('no active turn to interrupt');
    },
  });
  refused.started('T1', 'own');
  await assert.rejects(refused.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' }), /no active turn/);
  await settle();
  assert.deepEqual(refused.methods(), ['turn/interrupt']);
  // nor is its command's completion marked cut off
  assert.equal(refused.a.turnCommands.stopping.size, 0);
});

test('a Stop that failed leaves the command for the next Stop, and two Stops of one turn both see it', async () => {
  let fail = true;
  const s = setup({
    'turn/interrupt': () => {
      if (fail) throw new Error('timed out');
      return {};
    },
    'thread/backgroundTerminals/list': () => ({ data: [row('own', 'p1')] }),
    'thread/backgroundTerminals/terminate': () => ({ terminated: s.terminated().length === 1 }),
  });
  s.started('T1', 'own');
  await assert.rejects(s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' }), /timed out/);
  fail = false;
  await Promise.all([
    s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' }),
    s.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' }),
  ]);
  await settle();
  // each Stop that went through ends it; the second finds it gone (terminated: false), which says nothing
  assert.deepEqual(s.terminated(), [
    { threadId: 'th', processId: 'p1' },
    { threadId: 'th', processId: 'p1' },
  ]);
  assert.deepEqual(s.toasts(), []);
});

test('a list or terminate that fails is said; an app-server without background terminals says nothing', async () => {
  const failing = setup({
    'thread/backgroundTerminals/list': () => {
      throw new Error('list broke');
    },
  });
  failing.started('T1', 'own');
  await failing.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  await settle();
  assert.deepEqual(failing.toasts(), ["Couldn't stop the command this turn started: list broke"]);

  const missing = setup({
    'thread/backgroundTerminals/list': () => {
      throw Object.assign(new Error('Method not found'), { code: -32601 });
    },
  });
  missing.started('T1', 'own');
  await missing.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  await settle();
  assert.deepEqual(missing.toasts(), []);

  const refused = setup({
    'thread/backgroundTerminals/list': () => ({ data: [row('own', 'p1', 'sleep 20'), row('own2', 'p2', '')] }),
    'thread/backgroundTerminals/terminate': () => {
      throw new Error('denied');
    },
  });
  refused.started('T1', 'own');
  refused.started('T1', 'own2');
  await refused.a.request('turn/interrupt', { threadId: 'th', turnId: 'T1' });
  await settle();
  assert.deepEqual(refused.toasts(), ["Couldn't stop sleep 20: denied", "Couldn't stop the command: denied"]);
});

test('turn commands: kept by thread and turn, forgotten as they complete or their turn completes', () => {
  const c = new CodexTurnCommands();
  const cmd = (id?: string) => ({ type: 'commandExecution', ...(id ? { id } : {}) });
  c.observe('item/started', { turnId: 'T1', item: cmd('a') });
  c.observe('item/started', { threadId: 'th', item: cmd('a') });
  c.observe('item/started', { threadId: 'th', turnId: 'T1', item: cmd() });
  c.observe('item/started', { threadId: 'th', turnId: 'T1', item: { type: 'agentMessage', id: 'm' } });
  c.observe('item/started', undefined);
  assert.equal(c.running.size, 0);
  c.observe('item/started', { threadId: 'th', turnId: 'T1', item: cmd('a') });
  c.observe('item/started', { threadId: 'th', turnId: 'T1', item: cmd('b') });
  c.observe('item/started', { threadId: 'th', turnId: 'T2', item: cmd('c') });
  c.observe('item/completed', { threadId: 'other', item: cmd('a') });
  c.observe('item/completed', { threadId: 'th', item: { type: 'agentMessage', id: 'a' } });
  c.observe('turn/completed', { threadId: 'th', turn: {} });
  c.observe('item/completed', { threadId: 'th', item: cmd('b') });
  assert.deepEqual(c.take('th', 'T1'), ['a']);
  assert.deepEqual(c.take('th', 'T1'), ['a'], 'a snapshot: a retried Stop sees it again');
  assert.deepEqual(c.take('none', 'T1'), []);
  c.observe('turn/completed', { threadId: 'th', turn: { id: 'T1' } });
  c.observe('turn/completed', { threadId: 'th', turn: { id: 'T2' } });
  assert.equal(c.running.size, 0);
  // only a command item's completion is marked
  const p = { threadId: 'th', item: { type: 'agentMessage', id: 'a' } };
  assert.equal(c.markStopped('item/completed', p), p);
  assert.equal(c.markStopped('item/started', p), p);
  // while one command is being stopped, another's completion is left as it is
  const other = { threadId: 'th', item: cmd('z') };
  assert.ok(c.stopping.size > 0);
  assert.equal(c.markStopped('item/completed', other), other);
});

test('stopping commands: rows without a process or not listed as data are skipped; each call has a time limit', async () => {
  const calls: any[] = [];
  const io = {
    call: async (method: string, params: any, ms: number) => {
      calls.push([method, params, ms]);
      return method.endsWith('list') ? { data: [null, { itemId: 'a' }, row('a', 'p1')] } : { terminated: true };
    },
    toast: () => assert.fail('no toast'),
  };
  await stopTurnCommands(io, 'th', ['a']);
  assert.deepEqual(calls, [
    ['thread/backgroundTerminals/list', { threadId: 'th' }, STOP_COMMANDS_MS],
    ['thread/backgroundTerminals/terminate', { threadId: 'th', processId: 'p1' }, STOP_COMMANDS_MS],
  ]);
  calls.length = 0;
  await stopTurnCommands({ ...io, call: async (m: string, p: any, ms: number) => (calls.push([m, p, ms]), { terminals: [] }) }, 'th', [
    'a',
  ]);
  assert.equal(calls.length, 1);
});

/** A chat whose turn T1 is running on thread `th`, held (no resume needed), with the goal pause answering `pause`. */
function running(pause: Handler = () => ({ goal: { threadId: 'th', status: 'paused' } })) {
  const s = setup({ 'thread/goal/set': pause });
  s.a.leases.set('th', { at: Date.now() });
  s.a.state.patch('th', { activeTurn: { id: 'T1' } });
  const goalSets = () => s.sent.filter((m) => m.method === 'thread/goal/set').map((m) => m.params.status);
  return { ...s, goalSets };
}

test('Stop pauses a goal the adapter knows is active before any window has reported it, then interrupts', async () => {
  // the race of cuj-goal-and-away: a refusal stops the turn right after thread/goal/updated, before a window wrote the
  // goal back into main's session state (or with no window open at all)
  const s = running();
  s.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'active' } });
  await settle();
  assert.equal(s.a.state.get('th').goal, null, 'no window has reported the goal');
  assert.equal(await s.a.stopTurn('th'), true);
  await settle();
  assert.deepEqual(s.goalSets(), ['paused']);
  assert.deepEqual(
    s.methods().filter((m) => m === 'thread/goal/set' || m === 'turn/interrupt'),
    ['thread/goal/set', 'turn/interrupt'],
  );
  assert.equal(s.a.goals.get('th'), 'paused');
});

test('Stop pauses a goal only a window has reported, and leaves a chat without an active goal unpaused', async () => {
  const reported = running();
  reported.a.state.patch('th', { goal: { threadId: 'th', objective: 'o', status: 'active' } });
  await reported.a.stopTurn('th');
  await settle();
  assert.deepEqual(reported.goalSets(), ['paused']);

  const none = running();
  none.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'complete' } });
  await settle();
  await none.a.stopTurn('th');
  await settle();
  assert.deepEqual(none.goalSets(), []);
  assert.deepEqual(
    none.methods().filter((m) => m === 'turn/interrupt'),
    ['turn/interrupt'],
  );
});

test('a pause that fails tells the user while the adapter still has the goal active, and not once it ended', async () => {
  const fails = running(() => {
    throw new Error('nope');
  });
  fails.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'active' } });
  await settle();
  await fails.a.stopTurn('th');
  await settle();
  assert.deepEqual(fails.toasts(), ["Couldn't pause the goal, so it may go on: nope"]);

  let ended: ReturnType<typeof running>;
  ended = running(() => {
    ended.a.goals.set('th', 'complete');
    throw new Error('no goal');
  });
  ended.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'active' } });
  await settle();
  await ended.a.stopTurn('th');
  await settle();
  assert.deepEqual(ended.toasts(), []);
});

test('an app-server exit pauses, once Codex is back, every goal the adapter has active, reported by a window or not', () => {
  for (const evt of [{ kind: 'stopped' }, { kind: 'exit', code: 1 }]) {
    const s = setup();
    // the chats' exit paused tw (a window had reported it); th is active only in the adapter's record; tz is complete
    s.a.onExit = () => ['tw'];
    s.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'active' } });
    s.notify('thread/goal/updated', { threadId: 'tz', goal: { threadId: 'tz', objective: 'o', status: 'complete' } });
    s.a.onServer(evt);
    assert.deepEqual([...s.a.pauseOnReconnect].sort(), ['th', 'tw'], evt.kind);
  }
  // an exit that paused nothing in the chats still queues the adapter's own active goal
  const s = setup();
  s.a.onExit = () => undefined;
  s.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'active' } });
  s.a.onServer({ kind: 'stopped' });
  assert.deepEqual([...s.a.pauseOnReconnect], ['th']);
});

test("the adapter's own record of a goal wins over a window's report of it", async () => {
  // a window still shows the goal active after the adapter heard it complete: Stop sends no pause for a finished goal
  const s = running();
  s.notify('thread/goal/updated', { threadId: 'th', goal: { threadId: 'th', objective: 'o', status: 'complete' } });
  s.a.state.patch('th', { goal: { threadId: 'th', objective: 'o', status: 'active' } });
  await settle();
  await s.a.stopTurn('th');
  await settle();
  assert.deepEqual(s.goalSets(), []);
  assert.deepEqual(s.toasts(), []);
});
