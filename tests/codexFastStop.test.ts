// Fast Stop on a native Codex thread (BU-05, BU-06): the CodexAdapter sends the plugin's Interrupt
// hook (and a JS reset) right behind turn/interrupt, the chat goes idle once the app-server accepts the
// interrupt, the next turn waits only for the stopped turn to end, and the next native operation waits
// for the release (electron/harness/codex.cjs, electron/session/controller.cjs). The lifecycle itself is
// covered in tests/nativeControlMain.test.ts. The app-server is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

/** An app-server stand-in. `hold` lists methods it answers only when the test says so. */
function fakeServer(handlers: Record<string, (p: any) => any>, hold: Set<string>) {
  const s = {
    listeners: new Set<(e: any) => void>(),
    sent: [] as any[],
    held: [] as any[],
    proc: {},
    start() {},
    send(m: any) {
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      if (hold.has(m.method)) return void s.held.push(m);
      setImmediate(() => s.reply(m));
    },
    reply(m: any, override?: (p: any) => any) {
      try {
        const h = override ?? handlers[m.method];
        s.emit({ kind: 'message', msg: { id: m.id, result: h ? h(m.params) : {} } });
      } catch (e: any) {
        s.emit({ kind: 'message', msg: { id: m.id, error: { code: -32600, message: e.message } } });
      }
    },
    /** Answers the held requests of `method` (all of them), in order. */
    release(method: string, override?: (p: any) => any) {
      const due = s.held.filter((m) => m.method === method);
      s.held = s.held.filter((m) => m.method !== method);
      for (const m of due) s.reply(m, override);
    },
    emit(e: any) {
      for (const l of s.listeners) l(e);
    },
    notify(method: string, params: any) {
      s.emit({ kind: 'message', msg: { method, params } });
    },
    ask(id: string, method: string, params: any) {
      s.emit({ kind: 'message', msg: { id, method, params } });
    },
    methods: () => s.sent.filter((m) => m.method).map((m) => m.method),
    tools: () =>
      s.sent.filter((m) => m.method === 'mcpServer/tool/call').map((m) => [m.params.tool, m.params.arguments?.hook_event_name ?? null]),
  };
  return s;
}

function setup(o: { handlers?: Record<string, (p: any) => any>; hold?: string[]; native?: string[]; defaults?: boolean } = {}) {
  const hold = new Set(o.hold ?? []);
  const server = fakeServer(
    {
      initialize: () => ({ userAgent: 'fake', codexHome: '/h' }),
      'thread/resume': (p) => ({ thread: { id: p.threadId, cwd: '/work', preview: 'x' } }),
      'turn/start': () => ({ turn: { id: 'turn-2' } }),
      'mcpServer/tool/call': () => ({ content: [] }),
      ...o.handlers,
    },
    hold,
  );
  const native = new Set(o.native ?? ['nat']);
  const state = new SessionStore();
  const events: any[] = [];
  const stopped: any[] = [];
  const logs: string[] = [];
  const sky: string[] = [];
  let clock = 10_000;
  const a = new CodexAdapter({
    server,
    state,
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat === 'chat' ? 'nat' : chat, key: chat }),
    chatOf: (nid: string) => (nid === 'nat' ? 'chat' : nid),
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit: (e: any, target: any) => events.push({ ...e, target }),
    tools: { outgoing: (m: any) => m, observe() {}, exited() {}, setUserServers() {}, isNativeThread: (id: string) => native.has(id) },
    probe: null,
    now: () => clock,
    ...(o.defaults
      ? {}
      : {
          log: (line: string) => logs.push(line),
          onStopped: (chatId: string, turnId: string) => stopped.push([chatId, turnId]),
          onSkyProblem: (p: any) => sky.push(p.kind),
        }),
  });
  const toasts = () => events.filter((e) => e.kind === 'toast').map((e) => e.text);
  return { a, server, state, events, stopped, logs, sky, native, toasts, advance: (ms: number) => (clock += ms) };
}
const cua = (method: string, turnId: string, tool = 'js', id = 'j1', threadId = 'nat') => ({
  threadId,
  turnId,
  item: { type: 'mcpToolCall', server: 'cua_repl', tool, id },
});

test("a Codex Computer Use problem a native thread's cua_repl call reports reaches the adapter's listener", async () => {
  const mismatch = {
    ...cua('item/completed', 'T1').item,
    status: 'failed',
    error: { message: 'Sky Computer Use API version mismatch: client=a server=b' },
  };
  const { server, sky } = setup();
  server.notify('item/completed', { threadId: 'nat', turnId: 'T1', item: mismatch });
  await settle();
  assert.deepEqual(sky, ['versionMismatch']);
  // without a listener it is fine
  const quiet = setup({ defaults: true });
  quiet.server.notify('item/completed', { threadId: 'nat', turnId: 'T1', item: mismatch });
  await settle();
  assert.deepEqual(quiet.sky, []);
});

test("Codex Computer Use's service not starting reaches the listener; with no native thread to move, the chat gets no line (#1381)", async () => {
  const down = {
    ...cua('item/completed', 'T1').item,
    status: 'failed',
    error: { message: 'Sky Computer Use native pipe startup failed' },
  };
  const { server, sky, events } = setup();
  server.notify('item/completed', { threadId: 'nat', turnId: 'T1', item: down });
  await settle();
  assert.deepEqual(sky, ['serviceUnavailable']);
  assert.equal(events.filter((e) => e.params?.item?.type === 'statusNote').length, 0);
});

test('Stop on a native thread: the hook and the JS reset go out right behind turn/interrupt, and the chat is idle at its answer', async () => {
  const { a, server, stopped, logs, advance } = setup({ hold: ['mcpServer/tool/call'] });
  server.notify('item/started', cua('item/started', 'T1'));
  await a.request('turn/interrupt', { threadId: 'nat', turnId: 'T1' }).then((r: any) => assert.deepEqual(r, {}));
  // the wire order: the interrupt, the Interrupt hook, the reset; no wait for turn/completed
  assert.deepEqual(
    server.methods().filter((m) => !m.startsWith('initialize')),
    ['turn/interrupt', 'mcpServer/tool/call', 'mcpServer/tool/call'],
  );
  assert.deepEqual(server.tools(), [
    ['turn_ended', 'Interrupt'],
    ['js_reset', null],
  ]);
  assert.deepEqual(stopped, [['chat', 'T1']]);
  assert.deepEqual(logs, ['[native-stop] idle thread=nat turn=T1 ms=0 ok=true']);
  // the next turn waits for the stopped turn to end, not for the release
  let sent = false;
  const next = a.request('turn/start', { threadId: 'nat', input: [] }).then(() => (sent = true));
  await settle();
  assert.equal(sent, false);
  server.notify('turn/completed', { threadId: 'nat', turn: { id: 'T1', status: 'interrupted' } });
  await next;
  assert.equal(server.held.length, 2, 'the release is still on its way');
  // the next turn is told of the reset
  assert.match(
    server.sent.find((m) => m.method === 'turn/start').params.additionalContext['mopilot.native-runtime-state'].value,
    /reset the original cua_repl JS kernel/,
  );
  // the next native operation (a cua_repl approval) waits for the release
  server.ask('e1', 'mcpServer/elicitation/request', { threadId: 'nat', serverName: 'cua_repl' });
  await settle();
  assert.equal(a.state.get('chat').nativeCleanup?.phase, 'releasing');
  advance(450);
  server.release('mcpServer/tool/call');
  await settle();
  assert.equal(logs.at(-1), '[native-stop] released thread=nat turn=T1 ms=450 ok=true');
  assert.equal(a.state.get('chat').nativeCleanup, null);
});

test('a cua_repl approval held behind a release reaches the card once it confirms, and is declined when it fails', async () => {
  for (const outcome of ['confirms', 'fails'] as const) {
    const { a, server, events, toasts } = setup({ hold: ['mcpServer/tool/call'] });
    server.notify('item/started', cua('item/started', 'T1', 'click'));
    await a.request('turn/interrupt', { threadId: 'nat', turnId: 'T1' });
    server.ask('e1', 'mcpServer/elicitation/request', { threadId: 'nat', serverName: 'cua_repl' });
    await settle();
    assert.equal(
      events.some((e) => e.kind === 'request'),
      false,
      outcome,
    );
    server.release('mcpServer/tool/call', outcome === 'fails' ? () => ({ isError: true }) : undefined);
    await settle();
    if (outcome === 'confirms') {
      assert.deepEqual(
        events.find((e) => e.kind === 'request'),
        {
          kind: 'request',
          chatId: 'chat',
          request: { id: 'e1', method: 'mcpServer/elicitation/request', params: { threadId: 'nat', serverName: 'cua_repl' } },
          target: undefined,
        },
      );
      continue;
    }
    assert.equal(
      events.some((e) => e.kind === 'request'),
      false,
    );
    assert.deepEqual(
      server.sent.find((m) => m.id === 'e1'),
      { id: 'e1', result: { action: 'decline', content: null, _meta: null } },
    );
    assert.match(toasts().at(-1), /^Native browser and computer control is blocked: Native control cleanup failed\. Restart Codex/);
  }
});

test('native work after a failed release stops that turn with a clear status; the next turn itself was not refused', async () => {
  const { a, server, toasts, stopped } = setup({ handlers: { 'mcpServer/tool/call': () => ({ isError: true }) } });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  server.notify('turn/completed', { threadId: 'nat', turn: { id: 'T1', status: 'completed' } });
  await settle();
  assert.equal(a.state.get('chat').nativeCleanup?.phase, 'failed');
  assert.deepEqual(toasts(), ['Native control cleanup failed: The original runtime rejected turn cleanup.']);
  // the next turn starts
  await a.request('turn/start', { threadId: 'nat', input: [] });
  // ... and its first native operation stops it
  server.notify('item/started', cua('item/started', 'turn-2', 'click', 'c2'));
  await settle();
  assert.ok(toasts().some((t) => /^Native browser and computer control is blocked: Codex did not confirm it released them/.test(t)));
  const interrupt = server.sent.filter((m) => m.method === 'turn/interrupt').at(-1);
  assert.deepEqual(interrupt.params, { threadId: 'nat', turnId: 'turn-2' });
  assert.deepEqual(stopped, [['chat', 'turn-2']]);
});

test('native work after a failed release, when Codex refuses to stop the turn, still says why', async () => {
  const { a, server, toasts } = setup({
    handlers: {
      'mcpServer/tool/call': () => ({ isError: true }),
      'turn/interrupt': () => {
        throw new Error('no active turn');
      },
    },
  });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  server.notify('turn/completed', { threadId: 'nat', turn: { id: 'T1', status: 'completed' } });
  await settle();
  await a.request('turn/start', { threadId: 'nat', input: [] });
  server.notify('item/started', cua('item/started', 'turn-2', 'click', 'c2'));
  await settle();
  assert.ok(toasts().some((t) => /^Native browser and computer control is blocked/.test(t)));
  assert.ok(server.sent.some((m) => m.method === 'turn/interrupt' && m.params.turnId === 'turn-2'));
});

test('a refused interrupt does not idle the chat or hold the next turn; one without a turn id idles nothing', async () => {
  const { a, server, stopped } = setup({
    handlers: {
      'turn/interrupt': () => {
        throw new Error('no active turn');
      },
    },
  });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  await assert.rejects(a.request('turn/interrupt', { threadId: 'nat', turnId: 'T1' }), /no active turn/);
  assert.deepEqual(stopped, []);
  assert.equal(a.nativeLifecycle.stops.has('nat'), false);
  await a.request('turn/start', { threadId: 'nat', input: [] });
  const ok = setup();
  await ok.a.request('turn/interrupt', { threadId: 'nat' });
  assert.deepEqual(ok.stopped, []);
  // a managed thread's interrupt is a plain request
  await ok.a.request('turn/interrupt', { threadId: 'managed', turnId: 'M1' });
  assert.deepEqual(ok.stopped, []);
  assert.equal(ok.a.nativeLifecycle.stops.size, 0);
});

test('stopTurn interrupts the running turn and returns without waiting for the release', async () => {
  const { a, server, state, stopped } = setup({ hold: ['mcpServer/tool/call'] });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  state.patch('chat', { turn: 'running', activeTurn: { id: 'T1', human: true } });
  assert.equal(await a.stopTurn('chat'), true);
  assert.deepEqual(stopped, [['chat', 'T1']]);
  assert.equal(server.held.length, 1, 'the release runs on behind the stop');
  // a turn that has no id yet, or no turn, sends nothing
  const before = server.sent.length;
  state.patch('chat', { activeTurn: { id: 'pending-1', human: true } });
  assert.equal(await a.stopTurn('chat'), true);
  state.patch('chat', { activeTurn: null });
  assert.equal(await a.stopTurn('chat'), true);
  assert.equal(server.sent.length, before);
  server.release('mcpServer/tool/call');
  await settle();
});

test('startTurn reports a stopped turn that never ended rather than steering into it', async () => {
  const { a, events, server } = setup();
  a.nativeLifecycle.endTimeoutMs = 5;
  a.nativeLifecycle.interrupt('nat', 'T1');
  const r = await a.startTurn('chat', { kind: 'codex', id: 'nat' }, { id: 'q', text: 'next', attachments: [], opts: {} }, 1);
  assert.deepEqual(r, { started: false, error: 'Codex has not confirmed that the stopped turn ended. Try again.' });
  assert.deepEqual(
    server.methods().filter((method) => method === 'turn/start' || method === 'turn/steer'),
    [],
  );
  assert.equal(events.at(-1).text, "Couldn't open this chat for writing: Codex has not confirmed that the stopped turn ended. Try again.");
});

test('unloading and compaction still wait for the release; turn starts and other requests do not', async () => {
  const { a, server } = setup({ hold: ['mcpServer/tool/call'] });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  server.notify('turn/completed', { threadId: 'nat', turn: { id: 'T1', status: 'completed' } });
  await settle();
  const done: string[] = [];
  for (const [method, params] of [
    ['thread/unsubscribe', {}],
    ['thread/compact/start', {}],
    ['thread/read', {}],
    ['thread/goal/set', { status: 'active' }],
    ['thread/goal/set', { status: 'paused' }],
    ['turn/start', { input: [] }],
  ] as const)
    a.request(method, { threadId: 'nat', ...params }).then(() => done.push(`${method}:${(params as any).status ?? ''}`));
  a.request('thread/list', {}).then(() => done.push('thread/list'));
  await settle();
  assert.deepEqual(done.sort(), ['thread/goal/set:active', 'thread/goal/set:paused', 'thread/list', 'thread/read:', 'turn/start:']);
  server.release('mcpServer/tool/call');
  await settle();
  assert.deepEqual(done.filter((d) => /unsubscribe|compact/.test(d)).sort(), ['thread/compact/start:', 'thread/unsubscribe:']);
});

test('server requests other than a held cua_repl approval reach the windows at once', async () => {
  const { server, events } = setup({ hold: ['mcpServer/tool/call'] });
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  server.notify('turn/completed', { threadId: 'nat', turn: { id: 'T1', status: 'completed' } });
  server.ask('e1', 'mcpServer/elicitation/request', { threadId: 'nat', serverName: 'other' });
  server.ask('e2', 'mcpServer/elicitation/request', { serverName: 'cua_repl' });
  server.ask('e3', 'item/commandExecution/requestApproval', { threadId: 'nat' });
  server.ask('e4', 'item/tool/requestUserInput', undefined);
  server.ask('e5', 'mcpServer/elicitation/request', { threadId: 'quiet', serverName: 'cua_repl' });
  await settle();
  assert.deepEqual(
    events.filter((e) => e.kind === 'request').map((e) => [e.request.id, e.chatId, e.request.params]),
    [
      ['e1', 'chat', { threadId: 'nat', serverName: 'other' }],
      ['e2', null, { serverName: 'cua_repl' }],
      ['e3', 'chat', { threadId: 'nat' }],
      ['e4', null, {}],
      ['e5', 'quiet', { threadId: 'quiet', serverName: 'cua_repl' }],
    ],
  );
  server.release('mcpServer/tool/call');
  await settle();
});

test("a subagent of a native thread ends with SubagentStop on its parent's connection", async () => {
  const { a, server } = setup();
  server.notify('item/started', cua('item/started', 'T1', 'click'));
  server.notify('thread/started', { thread: { id: 'sub', parentThreadId: 'nat', cwd: '/work' } });
  server.notify('turn/started', { threadId: 'sub', turn: { id: 'S1' } });
  server.notify('turn/completed', { threadId: 'sub', turn: { id: 'S1', status: 'completed' } });
  await settle();
  const hook = server.sent.find((m) => m.method === 'mcpServer/tool/call');
  assert.deepEqual(hook.params, {
    threadId: 'nat',
    server: 'cua_repl',
    tool: 'turn_ended',
    arguments: { hook_event_name: 'SubagentStop', session_id: 'sub', turn_id: 'S1' },
  });
  await a.nativeLifecycle.ready('nat');
});

test('without a log or a stop listener, timings go to the console and the stop still completes', async () => {
  const lines: string[] = [];
  const info = console.info;
  console.info = (line: string) => void lines.push(line);
  try {
    const { a, server } = setup({ defaults: true });
    server.notify('item/started', cua('item/started', 'T1', 'click'));
    await a.request('turn/interrupt', { threadId: 'nat', turnId: 'T1' });
    await settle();
    assert.deepEqual(lines, [
      '[native-stop] idle thread=nat turn=T1 ms=0 ok=true',
      '[native-stop] released thread=nat turn=T1 ms=0 ok=true',
    ]);
  } finally {
    console.info = info;
  }
});

/* -- the controller: idle at the stop, the late completion ignored ---------- */

function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-fast-stop-'));
  const state = new SessionStore();
  const starts: any[] = [];
  const stops: string[] = [];
  const c = new ChatController({
    state,
    chats: new ChatsStore(path.join(dir, 'threads')),
    onStopped: (chatId: string) => stops.push(chatId),
    codex: { startTurn: async (chatId: string, _ref: any, item: any) => (starts.push([chatId, item.text]), { started: true }) },
    claudeTurns: {},
    acpTurns: {},
    switcher: {},
    claude: {},
    acp: {},
  });
  return { c, state, starts, stops, s: (id: string) => state.get(id) };
}
const codexMsg = (method: string, params: any) => ({ method, params });

test("a native stop idles the chat at once; the stopped turn's late completion does not end the next one", async () => {
  const { c, s, starts, stops } = controller();
  c.codexStopped('nobody', 'T1');
  c.send('t1', { text: 'first', attachments: [], opts: { human: true } }, 1);
  await tick();
  c.onCodexMessage(codexMsg('turn/started', { threadId: 't1', turn: { id: 'T1' } }));
  // another turn's stop is not this one's
  c.codexStopped('t1', 'T0');
  assert.equal(s('t1').turn, 'running');
  c.codexStopped('t1', 'T1');
  assert.equal(s('t1').turn, 'idle');
  assert.deepEqual(stops, ['t1']);
  // a stop acknowledged twice does nothing more
  c.codexStopped('t1', 'T1');
  assert.deepEqual(stops, ['t1']);
  // the next message starts right away, before the stopped turn's turn/completed
  c.send('t1', { text: 'second', attachments: [], opts: { human: true } }, 1);
  await tick();
  assert.equal(s('t1').turn, 'running');
  assert.match(s('t1').activeTurn.id, /^pending-/);
  c.onCodexMessage(codexMsg('turn/completed', { threadId: 't1', turn: { id: 'T1', status: 'interrupted' } }));
  assert.equal(s('t1').turn, 'running', "the late completion is the stopped turn's, not the new one's");
  assert.equal(c.rt('t1').stopped, null);
  // a completion without a turn id still ends the pending turn as before
  c.onCodexMessage(codexMsg('turn/completed', { threadId: 't1', turn: {} }));
  assert.equal(s('t1').turn, 'idle');
  assert.deepEqual(
    starts.map((x) => x[1]),
    ['first', 'second'],
  );
});
