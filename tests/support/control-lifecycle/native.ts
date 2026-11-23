// Native Codex plugin lifecycle and tool-session injection/unload cases.
import { test, assert, switchingChat, world, CodexAdapter, ToolSessions, CodexToolInjection, settle, mainApp } from './fixture.ts';

export function registerNative() {
  function fakeServer(handlers: Record<string, (p: any) => any>, hold: Set<string>) {
    const s: any = {
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
      reply(m: any) {
        const h = handlers[m.method];
        s.emit({ kind: 'message', msg: { id: m.id, result: h ? h(m.params) : {} } });
      },
      release(method: string) {
        const due = s.held.filter((m: any) => m.method === method);
        s.held = s.held.filter((m: any) => m.method !== method);
        for (const m of due) s.reply(m);
      },
      emit(e: any) {
        for (const l of s.listeners) l(e);
      },
      notify(method: string, params: any) {
        s.emit({ kind: 'message', msg: { method, params } });
      },
      tools: () =>
        s.sent
          .filter((m: any) => m.method === 'mcpServer/tool/call')
          .map((m: any) => [m.params.tool, m.params.arguments?.hook_event_name ?? null]),
      turnStarts: () => s.sent.filter((m: any) => m.method === 'turn/start').length,
    };
    return s;
  }

  function nativeApp(o: { hold?: string[] } = {}) {
    const native = new Set<string>();
    let turnIds = 0;
    const server = fakeServer(
      {
        initialize: () => ({ userAgent: 'fake', codexHome: '/h' }),
        'thread/resume': (p) => ({ thread: { id: p.threadId, cwd: '/work', preview: 'x' } }),
        'turn/start': () => ({ turn: { id: `T${++turnIds}` } }),
        'mcpServer/tool/call': () => ({ content: [] }),
      },
      new Set(o.hold ?? []),
    );
    let app: any;
    const adapter = new CodexAdapter({
      server,
      state: {
        get: (id: string) => app.state.get(id),
        patch: (id: string, p: any) => app.state.patch(id, p),
        has: (id: string) => app.state.has(id),
        localWriterToken: (id: string) => app.state.localWriterToken(id),
        markLocalWriter: (id: string) => app.state.markLocalWriter(id),
      },
      nativeOf: (chatId: string) => app.controller.ref(chatId),
      chatOf: (id: string) => app.controller.chatOf(id),
      prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
      emit: () => {},
      tools: { outgoing: (m: any) => m, observe() {}, exited() {}, setUserServers() {}, isNativeThread: (id: string) => native.has(id) },
      probe: null,
      log: () => {},
      observe: (m: any) => app.observe(m),
      onStopped: (chatId: string, turnId: string) => app.controller.codexStopped(chatId, turnId),
      onExit: () => app.controller.onCodexExit(),
    });
    app = mainApp({ codex: adapter });
    return { ...app, adapter, server, native };
  }

  const cua = (method: string, threadId: string, turnId: string, tool = 'js', id = 'j1') => ({
    threadId,
    turnId,
    item: { type: 'mcpToolCall', server: 'cua_repl', tool, id },
  });

  test("CM-L06a: a native Codex turn that used the plugin ends with the plugin's Stop hook, and the chat lets go once", async () => {
    const app = nativeApp();
    const chat = await app.codexChat();
    app.native.add(chat);
    await app.send(chat);
    assert.equal(app.turn(chat), 'running');
    app.server.notify('item/started', cua('item/started', chat, 'T1', 'click', 'c1'));
    app.server.notify('item/completed', cua('item/completed', chat, 'T1', 'click', 'c1'));
    app.server.notify('turn/completed', { threadId: chat, turn: { id: 'T1', status: 'completed' } });
    await settle();
    assert.equal(app.turn(chat), 'idle');
    assert.deepEqual(app.server.tools(), [['turn_ended', 'Stop']]);
    await app.adapter.nativeLifecycle.ready(chat);
  });

  test('CM-L06b: Stop on a native Codex turn sends the Interrupt hook and a JS reset at once; the next turn waits only for the stopped turn to end', async () => {
    const app = nativeApp({ hold: ['mcpServer/tool/call'] });
    const chat = await app.codexChat();
    app.native.add(chat);
    await app.send(chat);
    app.server.notify('item/started', cua('item/started', chat, 'T1'));
    await settle();
    await app.controller.stopChat(chat);
    await settle();
    assert.deepEqual(app.server.tools(), [
      ['turn_ended', 'Interrupt'],
      ['js_reset', null],
    ]);
    assert.equal(app.turn(chat), 'idle', 'idle at the interrupt answer, the release still on its way');
    // the next message: its turn/start waits for the stopped turn's turn/completed, not for the release
    await app.send(chat, 'next');
    assert.equal(app.server.turnStarts(), 1);
    app.server.notify('turn/completed', { threadId: chat, turn: { id: 'T1', status: 'interrupted' } });
    await settle();
    assert.equal(app.server.turnStarts(), 2);
    assert.equal(app.server.held.length, 2, 'the release is still on its way');
    app.server.release('mcpServer/tool/call');
    await settle();
  });

  test("CM-L06c: a chat that switched to Claude Code is not held by its old thread's stopped turn or pending release (both are keyed by the thread)", async () => {
    const app = nativeApp({ hold: ['mcpServer/tool/call'] });
    const chat = await app.codexChat();
    app.native.add(chat);
    await app.send(chat);
    app.server.notify('item/started', cua('item/started', chat, 'T1', 'click', 'c1'));
    await settle();
    await app.controller.stopChat(chat);
    await settle();
    // no turn/completed yet, and the plugin has not confirmed the release
    assert.ok(app.adapter.nativeLifecycle.stops.has(chat));
    assert.equal(app.adapter.nativeLifecycle.pending(chat), chat);
    await app.switchTo(chat, 'claude');
    await app.send(chat, 'on Claude');
    assert.deepEqual(app.starts, [['claude', chat, 'claude:' + app.sw.chats.record(chat).segments.at(-1).nativeId]]);
    assert.equal(app.turn(chat), 'running');
    assert.equal(app.server.turnStarts(), 1, 'nothing more went to the old thread');
    app.server.release('mcpServer/tool/call');
    await settle();
  });

  function injection(chatOf: (id: string) => string) {
    const sessions = new ToolSessions();
    const backends: string[] = [];
    const inj = new CodexToolInjection({
      sessions,
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      hasTools: () => true,
      chatOf,
      nativeEnabled: () => true,
      nativeSurfaces: () => ({ chrome: true, computer: true }),
      browserBackends: {
        available: () => true,
        loaded: (id: string) => void backends.push(`loaded ${id}`),
        unloaded: (id: string) => void backends.push(`unloaded ${id}`),
        exited: () => void backends.push('exited'),
      },
    });
    let id = 0;
    const tokens = new Map<string, string>();
    /** thread/resume as the adapter sends it, and the app-server's answer */
    const resume = (threadId: string) => {
      const out = inj.outgoing({ id: ++id, method: 'thread/resume', params: { threadId } });
      const server = Object.values((out.params?.config?.mcp_servers ?? {}) as Record<string, any>).find((s) => s?.env?.SAGE_MCP_TOKEN);
      if (server) tokens.set(threadId, server.env.SAGE_MCP_TOKEN);
      inj.observe({ id, result: { thread: { id: threadId } } });
    };
    const live = (threadId: string) => {
      const s = sessions.resolve(tokens.get(threadId));
      return s ? { key: s.key, serverName: s.serverName, chatId: s.chatId, segmentId: s.segmentId } : null;
    };
    return { inj, sessions, backends, resume, live, tokens };
  }

  test('CM-L07a: unloading a native thread suspends its sage-mcp session and its in-app browser backend; a resume rotates it, owned by the chat', async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1', 's0');
    const seg = await sw.switchTo('chat-1', 'codex');
    const x = injection(sw.chatOf);
    x.resume(seg.nativeId);
    const first = x.live(seg.nativeId);
    assert.deepEqual(first && [first.chatId, first.segmentId], ['chat-1', seg.nativeId]);
    const oldToken = x.tokens.get(seg.nativeId);
    x.inj.observe({ method: 'thread/closed', params: { threadId: seg.nativeId } });
    assert.equal(x.sessions.resolve(oldToken), null, 'the token stops working');
    assert.equal(x.inj.isNativeThread(seg.nativeId), false);
    x.resume(seg.nativeId);
    const again = x.live(seg.nativeId);
    assert.notEqual(x.tokens.get(seg.nativeId), oldToken, 'a new token');
    assert.deepEqual(again && [again.chatId, again.segmentId], ['chat-1', seg.nativeId]);
    assert.deepEqual(x.backends, [`loaded ${seg.nativeId}`, `unloaded ${seg.nativeId}`, `loaded ${seg.nativeId}`]);
  });

  test('CM-L07b: archiving or deleting a native thread ends its session and backend; a later resume opens a fresh one owned by the chat', async () => {
    for (const method of ['thread/archived', 'thread/deleted']) {
      const w = world();
      const sw = switchingChat(w);
      sw.startOnClaude('chat-1', 's0');
      const seg = await sw.switchTo('chat-1', 'codex');
      const x = injection(sw.chatOf);
      x.resume(seg.nativeId);
      const first = x.live(seg.nativeId)!;
      x.inj.observe({ method, params: { threadId: seg.nativeId } });
      assert.equal(x.sessions.get(first.key), null, `${method}: the session ended`);
      x.resume(seg.nativeId);
      const fresh = x.live(seg.nativeId)!;
      assert.notEqual(fresh.key, first.key, `${method}: a new session`);
      // the shared name (#2579), a token of its own: the ended session's can't stand in for it
      assert.equal(fresh.serverName, first.serverName);
      assert.deepEqual([fresh.chatId, fresh.segmentId], ['chat-1', seg.nativeId]);
      assert.deepEqual(x.backends, [`loaded ${seg.nativeId}`, `unloaded ${seg.nativeId}`, `loaded ${seg.nativeId}`]);
    }
  });

  test('CM-L07c: the app-server exiting ends every thread session and every backend; the next resume opens a fresh session owned by the chat', async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-1', 's0');
    const seg = await sw.switchTo('chat-1', 'codex');
    const started = (await sw.codex.startThread()).thread.id;
    const x = injection(sw.chatOf);
    x.resume(seg.nativeId);
    x.resume(started);
    const before = [x.live(seg.nativeId)!, x.live(started)!];
    x.inj.exited();
    for (const s of before) assert.equal(x.sessions.get(s.key), null);
    assert.equal(x.backends.at(-1), 'exited');
    assert.equal(x.inj.isNativeThread(seg.nativeId), false);
    x.resume(seg.nativeId);
    const fresh = x.live(seg.nativeId)!;
    assert.notEqual(fresh.key, before[0].key);
    assert.deepEqual([fresh.chatId, fresh.segmentId], ['chat-1', seg.nativeId]);
  });
}
