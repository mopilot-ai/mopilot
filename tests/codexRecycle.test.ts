// electron/harness/codexRecycle.cjs: an idle Codex app-server that still holds loaded threads (and their MCP servers)
// restarts, never while anything it holds is in use; and the connection's activity stamp it reads (codexConnection.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { codexRecycler, IDLE_MS, CHECK_MS } = require('../electron/harness/codexRecycle.cjs');
const { CodexConnection } = require('../electron/harness/codexConnection.cjs');

type Answer = (method: string, params: any) => any;

function setup(answer: Answer = (m) => (m === 'thread/loaded/list' ? { data: ['t1', 't2'] } : { data: [] })) {
  const log: string[] = [];
  const calls: any[] = [];
  let t = 10 * IDLE_MS;
  const server: any = { proc: { pid: 1 }, stop: () => log.push('stop') };
  const codex: any = {
    lastActivity: 0,
    down: false,
    restartTimer: null,
    recovering: null,
    running: new Set(),
    leases: new Map(),
    pending: new Map(),
    heldRequests: new Map(),
    prewarmed: new Set(),
    titling: new Map(),
    hidden: new Map(),
    realtime: new Set(),
    answer,
    call: async (method: string, params: any, ms: number, opts: any) => {
      calls.push({ method, params, ms, opts });
      return codex.answer(method, params);
    },
    connect: async () => log.push('connect'),
    onStatus: (e: any) => log.push(e.kind),
  };
  let busy = false;
  const lines: string[] = [];
  const r = codexRecycler({
    server: () => server,
    codex: () => codex,
    chatsBusy: () => busy,
    now: () => t,
    log: (l: string) => lines.push(l),
  });
  return { r, server, codex, log, calls, lines, setNow: (n: number) => (t = n), setBusy: (b: boolean) => (busy = b) };
}

test('an app-server quiet for IDLE_MS that holds loaded threads restarts, asking only quietly, and every window hears it is back', async () => {
  const { r, codex, log, calls, lines, setNow } = setup();
  codex.lastActivity = 1000;
  setNow(1000 + IDLE_MS - 1);
  assert.equal(await r.check(), false);
  assert.equal(calls.length, 0);
  setNow(1000 + IDLE_MS);
  assert.equal(await r.check(), true);
  assert.deepEqual(log, ['stop', 'connect', 'ready']);
  assert.deepEqual(
    calls.map((c) => [c.method, c.params.threadId ?? null]),
    [
      ['thread/loaded/list', null],
      ['thread/backgroundTerminals/list', 't1'],
      ['thread/backgroundTerminals/list', 't2'],
    ],
  );
  // each of its reads is bounded
  assert.ok(calls.every((c) => c.ms > 0));
  assert.match(lines[0], /2 loaded thread/);
});

test('nothing loaded, or an answer that is not a list of thread ids, leaves the process alone', async () => {
  for (const answer of [{ data: [] }, null, {}, { data: 'x' }, { data: [1, null] }]) {
    const { r, log } = setup((m) => (m === 'thread/loaded/list' ? answer : { data: [] }));
    assert.equal(await r.check(), false, JSON.stringify(answer));
    assert.deepEqual(log, []);
  }
  const { r, codex, log } = setup();
  codex.answer = () => {
    throw new Error('did not answer');
  };
  assert.equal(await r.check(), false);
  assert.deepEqual(log, []);
});

test('a background terminal in any loaded thread keeps the process, and so does a terminal read that fails or makes no sense', async () => {
  const cases: [string, Answer][] = [
    ['one running', (m, p) => (m === 'thread/loaded/list' ? { data: ['t1', 't2'] } : { data: p.threadId === 't2' ? [{}] : [] })],
    ['old shape', (m) => (m === 'thread/loaded/list' ? { data: ['t1'] } : { terminals: [{}] })],
    ['unreadable', (m) => (m === 'thread/loaded/list' ? { data: ['t1'] } : { nope: true })],
    [
      'rejected',
      (m) => {
        if (m === 'thread/loaded/list') return { data: ['t1'] };
        throw new Error('gone');
      },
    ],
  ];
  for (const [name, answer] of cases) {
    const { r, log } = setup(answer);
    assert.equal(await r.check(), false, name);
    assert.deepEqual(log, [], name);
  }
  // the older answer shape with none running lets it go
  const { r, log } = setup((m) => (m === 'thread/loaded/list' ? { data: ['t1'] } : { terminals: [] }));
  assert.equal(await r.check(), true);
  assert.deepEqual(log, ['stop', 'connect', 'ready']);
});

test('anything in use keeps the process: a turn, lease, request, composer thread, title, helper turn, voice session, goal recovery, crash restart or a chat waiting', async () => {
  const holds: [string, (c: any) => void][] = [
    ['running', (c) => c.running.add('t1')],
    ['lease', (c) => c.leases.set('t1', {})],
    ['pending request', (c) => c.pending.set('cx:1', {})],
    ['held server request', (c) => c.heldRequests.set(1, {})],
    ['prewarmed', (c) => c.prewarmed.add('t3')],
    ['titling', (c) => c.titling.set('t1', 'x')],
    ['hidden helper', (c) => c.hidden.set('t9', {})],
    ['voice session', (c) => c.realtime.add('t1')],
    ['recovering goals', (c) => (c.recovering = Promise.resolve())],
    ['crash restart', (c) => (c.restartTimer = 'connecting')],
    ['down', (c) => (c.down = true)],
  ];
  for (const [name, hold] of holds) {
    const { r, codex, log, calls } = setup();
    hold(codex);
    assert.equal(await r.check(), false, name);
    assert.deepEqual([log, calls.length], [[], 0], name);
  }
  const { r, log, setBusy } = setup();
  setBusy(true);
  assert.equal(await r.check(), false);
  assert.deepEqual(log, []);
  // no process, or no adapter yet
  const none = codexRecycler({ server: () => ({ proc: null }), codex: () => ({}) });
  assert.equal(await none.check(), false);
  const noAdapter = codexRecycler({ server: () => ({ proc: {} }), codex: () => null });
  assert.equal(await noAdapter.check(), false);
});

test('what happens while it asks keeps the process: activity, a turn, a chat waiting, a quit, another restart', async () => {
  const during: [string, (s: ReturnType<typeof setup>) => void][] = [
    ['request or message', (s) => (s.codex.lastActivity = 5)],
    ['turn started', (s) => s.codex.running.add('t1')],
    ['chat waits on the user', (s) => s.setBusy(true)],
    ['quit', (s) => s.r.stop()],
    ['restarted by Restart to apply', (s) => (s.server.proc = { pid: 2 })],
  ];
  for (const [name, act] of during) {
    const s = setup();
    const base = s.codex.answer;
    s.codex.answer = (m: string, p: any) => {
      if (m === 'thread/backgroundTerminals/list') act(s);
      return base(m, p);
    };
    assert.equal(await s.r.check(), false, name);
    assert.deepEqual(s.log, [], name);
  }
});

test('one pass at a time; a stopped recycler checks nothing', async () => {
  const s = setup();
  let release: (v: any) => void = () => {};
  s.codex.answer = (m: string) => (m === 'thread/loaded/list' ? new Promise((r) => (release = r)) : { data: [] });
  const first = s.r.check();
  assert.equal(await s.r.check(), false);
  release({ data: ['t1'] });
  assert.equal(await first, true);
  assert.equal(s.calls.filter((c) => c.method === 'thread/loaded/list').length, 1);
  s.r.stop();
  assert.equal(await s.r.check(), false);
});

test('after a restart the fresh app-server holds nothing and the next pass leaves it; the interval runs passes until quit', async () => {
  const s = setup();
  assert.equal(await s.r.check(), true);
  s.codex.answer = (m: string) => (m === 'thread/loaded/list' ? { data: [] } : { data: [] });
  assert.equal(await s.r.check(), false);
  assert.deepEqual(s.log, ['stop', 'connect', 'ready']);

  // the timer: started once, unref'd, cleared on stop, never again after it
  const ticks: (() => void)[] = [];
  let unref = 0;
  let cleared = 0;
  const timers: any = {
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, CHECK_MS);
      ticks.push(fn);
      return { unref: () => unref++ };
    },
    clearInterval: () => cleared++,
  };
  const failing = setup();
  failing.codex.connect = async () => {
    throw new Error('Codex failed to start');
  };
  const r = codexRecycler({ server: () => failing.server, codex: () => failing.codex, timers, now: () => 10 * IDLE_MS });
  r.start();
  r.start();
  assert.deepEqual([ticks.length, unref], [1, 1]);
  // a pass that fails (the restart's connect) is noted, not thrown into the timer
  ticks[0]();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(failing.log, ['stop']);
  r.stop();
  assert.equal(cleared, 1);
  r.start();
  assert.equal(ticks.length, 1);
  // stop before any start clears nothing
  const idle = codexRecycler({ server: () => null, codex: () => null, timers });
  idle.stop();
  assert.equal(cleared, 1);
});

test('the connection stamps activity only when a thread is loaded or worked in, or sends an event of its own', () => {
  let t = 100;
  const sent: any[] = [];
  const conn: any = Object.assign(Object.create(CodexConnection.prototype), {
    serverObservers: new Set(),
    now: () => t,
    seq: 0,
    pending: new Map(),
    server: { send: (m: any) => sent.push(m) },
    provider: () => null,
    providerPending: () => null,
    keptProviders: () => ({}),
    userTrust: null,
    tools: null,
    lastActivity: 0,
    realtime: new Set(),
    answerHook: () => {},
    onMessage: () => {},
  });
  // reads (a window's polling, the recycler's own) load nothing
  for (const m of ['thread/loaded/list', 'thread/attachment/list', 'thread/read', 'thread/list', 'account/read', 'thread/startish'])
    void conn.call(m, { threadId: 't' });
  assert.equal(conn.lastActivity, 0);
  for (const m of [
    'thread/start',
    'thread/fork',
    'thread/resume',
    'thread/revert',
    'thread/shellCommand',
    'thread/compact/start',
    'review/start',
    'turn/start',
    'turn/steer',
    'thread/queue/start',
    'thread/realtime/start',
    'thread/realtime/appendText',
  ]) {
    t++;
    void conn.call(m, { threadId: 't' });
    assert.equal(conn.lastActivity, t, m);
  }
  const at = t;
  t = 500;
  // an answer, and an event about no thread (an account's limits), are not activity
  conn.onServer({ kind: 'message', msg: { id: 'cx:1', result: { threadId: 't' } } });
  conn.onServer({ kind: 'message', msg: { method: 'account/rateLimits/updated', params: {} } });
  assert.equal(conn.lastActivity, at);
  conn.onServer({ kind: 'message', msg: { method: 'item/started', params: { threadId: 't' } } });
  assert.equal(conn.lastActivity, 500);
  assert.equal(sent.length, 18);
  // a voice session holds its thread from start until it stops or closes
  assert.deepEqual([...conn.realtime], ['t']);
  void conn.call('thread/realtime/stop', { threadId: 't' });
  assert.equal(conn.realtime.size, 0);
  void conn.call('thread/realtime/start', { threadId: 'v' });
  void conn.call('thread/realtime/start', {});
  conn.onServer({ kind: 'message', msg: { method: 'thread/realtime/closed', params: { threadId: 'v' } } });
  assert.equal(conn.realtime.size, 0);
});
