// Codex harness reconnect unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, settle, wait, NO_REPLY, SEND_THROWS, thread, fakeServer, setup } from './fixture';

export function registerReconnectCases() {
  test('the adapter takes its defaults: chatOf identity, empty prefs, the real probe, no-op hooks', async () => {
    const server = fakeServer({ initialize: () => ({ userAgent: 'codex_cli_rs/0.50.0' }) });
    const a = new CodexAdapter({ server, nativeOf: () => null });
    assert.equal(a.chatOf('x'), 'x');
    assert.deepEqual(a.prefs(), {});
    assert.equal(a.chatConfig('x'), null);
    assert.equal(a.provider(), null);
    assert.equal(typeof a.probe, 'function');
    a.emit({});
    a.observe({});
    a.onExit('x');
    a.onStatus({});
    a.onFirstStart();
    assert.equal(a.clientInfo.title, 'MoPilot');
    assert.ok(Math.abs(a.now() - Date.now()) < 1000);
  });

  test('call sends empty params for none, and fails cleanly when the pipe throws', async () => {
    const { a, server } = setup({ boom: SEND_THROWS });
    const p = a.call('model/list');
    assert.deepEqual(server.sent.at(-1).params, {});
    await p;
    await assert.rejects(a.call('boom', {}), /pipe closed/);
    assert.equal(a.pending.size, 0);
  });

  test("the user's own MCP servers: read once per app-server, each with its entry (#2999 C4); none configured hands over none", async () => {
    for (const [cfg, servers] of [
      [() => ({}), {}],
      [() => ({ config: { mcp_servers: { a: {}, b: {} } } }), { a: {}, b: {} }],
    ] as const) {
      const got: any[] = [];
      const tools = { setUserServers: (s: unknown) => got.push(s), outgoing: (m: any) => m, observe() {}, exited() {} };
      const { a } = setup({ 'config/read': cfg, 'thread/start': () => ({ thread: thread('n') }) }, { tools });
      await a.request('thread/start', {});
      await a.request('thread/fork', {});
      assert.deepEqual(got, [servers]);
    }
  });

  test("the user's own MCP servers: a failed read hands over none and is read again at the next thread start", async () => {
    let reads = 0;
    const cfg = () => {
      if (++reads === 1) throw new Error('app-server busy');
      return { config: { mcp_servers: { mine: {} } } };
    };
    const got: any[] = [];
    const tools = { setUserServers: (s: unknown) => got.push(s), outgoing: (m: any) => m, observe() {}, exited() {} };
    const { a } = setup({ 'config/read': cfg, 'thread/start': () => ({ thread: thread('n') }) }, { tools });
    await a.request('thread/start', {});
    await a.request('thread/fork', {});
    await a.request('thread/start', {});
    assert.deepEqual(got, [{}, { mine: {} }]);
    assert.equal(reads, 2, 'a successful read is kept');
  });

  test('onMessage ignores nothing-messages, unknown responses and method-less messages; requests without a thread have no chat', () => {
    const { server, events } = setup();
    server.emit({ kind: 'message', msg: null });
    server.emit({ kind: 'message', msg: { id: 'nobody', result: 1 } });
    server.emit({ kind: 'message', msg: {} });
    assert.equal(events.length, 0);
    server.emit({ kind: 'message', msg: { id: 'r', method: 'account/chatgptAuthTokens/refresh' } });
    assert.deepEqual(events[0].e, {
      kind: 'request',
      chatId: null,
      request: { id: 'r', method: 'account/chatgptAuthTokens/refresh', params: {} },
    });
  });

  test('bookkeeping: names, threads started for a later segment or for nobody, goals without a thread', () => {
    const { a, server, events } = setup({}, { segments: { chat: 'seg2' } });
    server.notify('thread/started', { thread: thread('seg2') });
    assert.equal(events.filter((x) => x.e.kind === 'notification').length, 0);
    server.notify('thread/started', {});
    assert.equal(events.at(-1)!.e.chatId, null);
    server.notify('thread/name/updated', { threadId: 'seg2', name: 'Alt name' });
    assert.equal(a.meta.get('seg2').name, 'Alt name');
    server.notify('thread/name/updated', { threadId: 'seg2' });
    assert.equal(a.meta.get('seg2').name, null);
    server.notify('thread/name/updated', { threadId: 'unknown', threadName: 'x' });
    assert.equal(a.meta.has('unknown'), false);
    server.notify('thread/goal/updated', { threadId: 'seg2' });
    // a goal with no status is recorded as cleared (null), so no gate falls back to a window's older report (#2759)
    assert.equal(a.goals.get('seg2'), null);
    server.notify('thread/goal/cleared', {});
    // with no thread nothing is recorded
    assert.deepEqual([...a.goals], [['seg2', null]]);
    server.notify('turn/started', { threadId: 'seg2' });
    assert.ok(a.running.has('seg2'));
    assert.equal(a.turnOf.has('seg2'), false);
    server.notify('turn/started', {});
    server.notify('turn/completed', {});
    assert.ok(a.running.has('seg2'));
  });

  test('a manual compaction marks only untriggered compaction items, in item and turn notifications', () => {
    const { a, server, events } = setup();
    a.manualCompactions.add('tc');
    server.notify('item/completed', { threadId: 't', turnId: 'tc', item: { type: 'contextCompaction', trigger: 'auto' } });
    assert.equal(events.at(-1)!.e.params.item.trigger, 'auto');
    server.notify('item/completed', { threadId: 't', turnId: 'tc', item: { type: 'agentMessage' } });
    assert.equal(events.at(-1)!.e.params.item.trigger, undefined);
    server.notify('turn/completed', { threadId: 't', turn: { id: 'tc', items: [{ type: 'contextCompaction' }, null] } });
    assert.deepEqual(events.at(-1)!.e.params.turn.items, [{ type: 'contextCompaction', trigger: 'manual' }, null]);
    server.notify('turn/completed', { threadId: 't', turn: { id: 'other', items: [{ type: 'contextCompaction' }] } });
    assert.equal(events.at(-1)!.e.params.turn.items[0].trigger, undefined);
  });

  test('the process going ends a helper turn in flight with what it had', async () => {
    const { a, server } = setup({ 'turn/start': () => ({}) });
    const p = a.helperTurn('h', { input: [] }, 10_000);
    await settle();
    server.notify('item/agentMessage/delta', { threadId: 'h', delta: 'part' });
    server.emit({ kind: 'stopped' });
    assert.equal(await p, 'part');
  });

  test('the process going: hidden listeners without done are dropped too', () => {
    const { a, server } = setup();
    a.hidden.set('h', { on() {} });
    server.emit({ kind: 'stopped' });
    assert.equal(a.hidden.size, 0);
  });

  test('an error while the process is still there tells the windows it is coming back, and its exit restarts it', async () => {
    const { a, server, statuses } = setup({}, { backoff: [5_000] });
    await a.initialize();
    server.emit({ kind: 'error', error: 'x' });
    assert.equal(statuses.at(-1).restarting, true);
    assert.equal(a.restartTimer, null);
    server.emit({ kind: 'exit', code: 1 });
    // that process had answered: its exit is a crash (restarted), not a start that failed
    assert.deepEqual(statuses.at(-1), { kind: 'restarting', attempt: 1, inMs: 5_000 });
    assert.equal(a.failedStarts, 0);
    assert.equal(statuses.filter((s) => s.copy).length, 0, 'no copy is named for quitting as it started');
    // already pending: not scheduled twice
    a.scheduleRestart();
    assert.equal(statuses.filter((s) => s.kind === 'restarting').length, 1);
    clearTimeout(a.restartTimer);
  });

  test('restarts: an exit while reconnecting tries again; a Codex up long enough starts the backoff over', async () => {
    const { a, server, statuses, clock } = setup(
      { initialize: (_p: any, n: number) => (n === 2 ? new Promise(() => {}) : { userAgent: 'x' }) },
      { backoff: [1, 1, 1] },
    );
    await a.initialize();
    server.emit({ kind: 'exit', code: 1 });
    await wait(10);
    // the restart's initialize never answered: it exits while connecting, which counts as a crash
    assert.equal(a.restartTimer, 'connecting');
    server.emit({ kind: 'exit', code: 1 });
    assert.equal(statuses.at(-1).attempt, 2);
    await wait(10);
    await settle();
    assert.equal(statuses.at(-1).kind, 'ready');
    // up past STABLE_MS: the next crash is attempt 1 again
    clock.t += 61_000;
    server.emit({ kind: 'exit', code: 1 });
    assert.deepEqual(statuses.at(-1), { kind: 'restarting', attempt: 1, inMs: 1 });
    clearTimeout(a.restartTimer);
  });

  test('a restart whose initialize fails kills a process still there, or tries again without one', async () => {
    const { a, server, statuses } = setup(
      {
        initialize: (_p: any, n: number) => {
          if (n > 1) throw new Error('bad init');
          return { userAgent: 'x' };
        },
      },
      { backoff: [1, 1] },
    );
    await a.initialize();
    server.emit({ kind: 'exit', code: 1 });
    const proc = server.proc;
    await wait(10);
    await settle();
    assert.equal(proc.kills, 1);
    assert.equal(proc.stopped, true);
    // no process left: scheduled again by itself
    server.proc = null;
    a.restartTimer = null;
    a.scheduleRestart();
    await wait(10);
    await settle();
    assert.deepEqual(
      statuses.filter((s) => s.kind === 'restarting').map((s) => s.attempt),
      [1, 2],
    );
    assert.equal(statuses.at(-1).kind, 'gaveUp');
  });

  test('a Codex that never answers initialize is ended, so the next connect starts a fresh one', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { a, server } = setup({ initialize: NO_REPLY });
    const proc = server.proc;
    const p = a.connect();
    t.mock.timers.tick(30_000);
    await assert.rejects(p, /did not answer initialize/);
    // initializing it again would be refused ("Already initialized")
    assert.equal(proc.kills, 1);
    assert.equal(a.init, null);
  });
}
