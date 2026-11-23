// Native-control config unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexThreadConfig,
  nativeThreadConfig,
  nativeControlOff,
  inAppBrowserNote,
  scopeNote,
  NATIVE_CUA_PLUGIN,
  IN_APP_BROWSER_CONTEXT,
  chromeSelectionNote,
  injection,
} from './fixture';

export function registerConfigCases() {
  test('the native fragment turns the vendor plugin on and keeps the user node_repl off only where configured', () => {
    assert.deepEqual(nativeThreadConfig(), { mcp_servers: {}, plugins: { [NATIVE_CUA_PLUGIN]: { enabled: true } } });
    assert.deepEqual(nativeThreadConfig({ userServers: ['node_repl', 'mine'] }).mcp_servers, { node_repl: { enabled: false } });
    assert.deepEqual(nativeThreadConfig({ userServers: ['node_repl'], disableUserNodeRepl: false }).mcp_servers, {});
    // managed and helper threads keep the plugin off
    assert.deepEqual(nativeControlOff({}).plugins, { [NATIVE_CUA_PLUGIN]: { enabled: false } });
    const native = codexThreadConfig({
      serverName: 'sage_0123456789ab',
      command: '/bin/sage-mcp',
      socketPath: '/s.sock',
      token: 't',
      userServers: ['node_repl'],
      native: true,
    });
    assert.deepEqual(native.plugins, { [NATIVE_CUA_PLUGIN]: { enabled: true } });
    assert.deepEqual(Object.keys(native.mcp_servers), ['sage_0123456789ab', 'node_repl']);
    assert.equal(native.mcp_servers.sage_0123456789ab.default_tools_approval_mode, 'approve');
  });

  test("the in-app browser note names the thread's own sage server", () => {
    const note = inAppBrowserNote('sage_0123456789ab');
    assert.equal(note.kind, 'application');
    assert.match(note.value, /browser_\* tools of the sage_0123456789ab MCP server/);
    assert.match(note.value, /Browser plugin's Chrome backend drives the browser the ChatGPT extension is connected to/);
    assert.match(note.value, /For multi-step built-in browser work, prefer one browser_script call/);
  });

  test('a native thread gets the vendor plugin and a sage-mcp session that hides what the plugin already does', () => {
    const hideAsked: string[] = [];
    const nativeHide = (name: string) => (hideAsked.push(name), name.startsWith('computer_'));
    const { sessions, inj, server } = injection({ nativeEnabled: () => true, nativeHide });
    const out = inj.outgoing({ id: 1, method: 'thread/start', params: { config: { model: 'm' } } });
    assert.equal(out.params.config.model, 'm');
    assert.deepEqual(out.params.config.plugins, { [NATIVE_CUA_PLUGIN]: { enabled: true } });
    const name = server(out);
    assert.ok(name);
    assert.equal(inj.isNativeThread('th1'), false, 'not native before the app-server loads it');
    inj.observe({ id: 1, result: { thread: { id: 'th1' } } });
    assert.equal(inj.isNativeThread('th1'), true);
    const s = sessions.get(inj.byThread.get('th1'));
    assert.equal(s.serverName, name);
    assert.equal(s.hide, nativeHide);
    // a resume of the unloaded thread rotates the same session with the hide filter of the path it gets now
    inj.observe({ method: 'thread/closed', params: { threadId: 'th1' } });
    assert.equal(inj.isNativeThread('th1'), false);
    inj.nativeEnabled = () => false;
    const resumed = inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th1' } });
    assert.equal(server(resumed), name);
    assert.deepEqual(resumed.params.config.plugins, { [NATIVE_CUA_PLUGIN]: { enabled: false } });
    inj.observe({ id: 2, result: { thread: { id: 'th1' } } });
    assert.equal(inj.isNativeThread('th1'), false, 'a managed thread now');
    assert.equal(sessions.get(inj.byThread.get('th1')).hide, null, "a managed thread's session shows every tool again");
  });

  test("without a harness pid a session still opens; a failed resume suspends the thread's session", () => {
    const { sessions, inj } = injection({ nativeEnabled: () => true, harnessPid: () => undefined });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    const key = inj.byThread.get('th');
    assert.equal(sessions.get(key).harnessPid, null);
    inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
    const resumed = inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th' } });
    const token = resumed.params.config.mcp_servers[sessions.get(key).serverName].env.SAGE_MCP_TOKEN;
    assert.ok(sessions.resolve(token));
    inj.observe({ id: 2, error: { message: 'locked' } });
    assert.equal(sessions.resolve(token), null, 'the rotated token stops working');
    assert.ok(sessions.get(key), 'the session stays for a later resume');
    assert.equal(inj.isNativeThread('th'), false);
    // a failed start ends the session it opened
    inj.outgoing({ id: 9, method: 'thread/start', params: {} });
    const startKey = inj.pending.get(9).key;
    inj.observe({ id: 9, result: {} });
    assert.equal(sessions.get(startKey), null);
    // a resume of a thread whose session is gone opens a new one, also without a pid
    inj.byThread.set('lost', 'codex:missing');
    inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'lost' } });
    assert.notEqual(inj.byThread.get('lost'), 'codex:missing');
    assert.equal(sessions.get(inj.byThread.get('lost')).harnessPid, null);
  });

  test('a resume of a thread with no session yet opens one carrying the native hide filter', () => {
    const nativeHide = () => true;
    const { sessions, inj } = injection({ nativeEnabled: () => true, nativeHide });
    inj.outgoing({ id: 1, method: 'thread/resume', params: { threadId: 'old' } });
    inj.observe({ id: 1, result: { thread: { id: 'old' } } });
    const s = sessions.get(inj.byThread.get('old'));
    assert.equal(s.hide, nativeHide);
    assert.equal(s.chatId, 'old');
    assert.equal(inj.isNativeThread('old'), true);
  });

  test('without sage-mcp a native thread still gets the vendor plugin; a managed one is left as Codex has it', () => {
    const { sessions, inj } = injection({ hasTools: () => false, nativeEnabled: () => true, disableUserNodeRepl: () => true });
    inj.setUserServers(['node_repl']);
    const msg = { id: 1, method: 'thread/start', params: {} };
    const out = inj.outgoing(msg);
    assert.deepEqual(out.params.config, {
      mcp_servers: { node_repl: { enabled: false } },
      plugins: { [NATIVE_CUA_PLUGIN]: { enabled: true } },
    });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    assert.equal(inj.isNativeThread('th'), true);
    assert.equal(inj.byThread.has('th'), false);
    // the vendor plugin answers for the thread: no sage-mcp session was opened for it
    assert.equal(sessions.byKey.size, 0);
    inj.nativeEnabled = () => false;
    const managed = { id: 2, method: 'thread/start', params: {} };
    assert.equal(inj.outgoing(managed), managed);
  });

  test('a thread loaded without sage-mcp ends the session an earlier load gave it', () => {
    let tools = true;
    const { sessions, inj } = injection({ hasTools: () => tools, nativeEnabled: () => true });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    const key = inj.byThread.get('th');
    assert.ok(sessions.get(key));
    inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
    tools = false;
    inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th' } });
    inj.observe({ id: 2, result: { thread: { id: 'th' } } });
    assert.equal(sessions.get(key), null);
    assert.equal(inj.byThread.has('th'), false);
    assert.equal(inj.isNativeThread('th'), true);
    // a failed native load without sage-mcp has no session to end
    inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
    inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th' } });
    assert.equal(inj.observe({ id: 3, error: { message: 'no' } }), false);
    assert.equal(inj.isNativeThread('th'), false);
    // a load without sage-mcp of a thread that never had a session
    inj.outgoing({ id: 4, method: 'thread/start', params: {} });
    inj.observe({ id: 4, result: { thread: { id: 'fresh' } } });
    assert.equal(inj.isNativeThread('fresh'), true);
  });

  test('requests without an id and other methods pass through untouched; a loaded thread gets its own config again', () => {
    const { inj } = injection({ nativeEnabled: () => true });
    assert.equal(inj.outgoing(null), null);
    const noId = { method: 'thread/start', params: {} };
    assert.equal(inj.outgoing(noId), noId);
    const other = { id: 1, method: 'turn/start', params: { threadId: 'x' } };
    assert.equal(inj.outgoing(other), other);
    const noThread = { id: 2, method: 'thread/resume', params: {} };
    assert.equal(inj.outgoing(noThread), noThread);
    const started = inj.outgoing({ id: 3, method: 'thread/start' });
    inj.observe({ id: 3, result: { thread: { id: 'th' } } });
    // Codex may respawn a loaded thread from a resume's config (#2500): the same config again
    const loaded = inj.outgoing({ id: 4, method: 'thread/resume', params: { threadId: 'th' } });
    assert.deepEqual(loaded.params.config, started.params.config);
    // a helper thread never picks up the vendor plugin, even on the native flag
    const helper = inj.outgoing({ id: 5, method: 'thread/start', params: {} }, { helper: true });
    assert.deepEqual(helper.params.config.plugins, { [NATIVE_CUA_PLUGIN]: { enabled: false } });
    const helperResume = { id: 6, method: 'thread/resume', params: { threadId: 'h' } };
    assert.equal(inj.outgoing(helperResume, { helper: true }), helperResume);
  });

  test('unloading a thread drops its native path, also for a thread without a sage-mcp session', () => {
    const { inj } = injection({ hasTools: () => false, nativeEnabled: () => true });
    for (const [i, method] of ['thread/closed', 'thread/archived', 'thread/deleted'].entries()) {
      const id = `t${i}`;
      inj.outgoing({ id: i, method: 'thread/start', params: {} });
      inj.observe({ id: i, result: { thread: { id } } });
      assert.equal(inj.isNativeThread(id), true);
      assert.equal(inj.observe({ method, params: { threadId: id } }), false);
      assert.equal(inj.isNativeThread(id), false, method);
    }
    assert.equal(inj.observe(null), false);
    assert.equal(inj.observe({ method: 'turn/started', params: {} }), false);
  });

  test('an exit ends every session, including pending loads, and forgets every native thread', () => {
    const { sessions, inj } = injection({ nativeEnabled: () => true });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    inj.outgoing({ id: 2, method: 'thread/start', params: {} });
    const pendingKey = inj.pending.get(2).key;
    inj.hasTools = () => false;
    inj.outgoing({ id: 3, method: 'thread/start', params: {} });
    assert.equal(inj.pending.get(3).key, null);
    inj.exited();
    assert.equal(inj.isNativeThread('th'), false);
    assert.equal(sessions.get(pendingKey), null);
    assert.equal(sessions.byKey.size, 0);
    assert.equal(inj.pending.size, 0);
  });

  /* ---------- turnContext: the built-in browser note ---------- */

  /** The note a thread's turn carries for its browser tools: MoPilot's scope note, then the routing. */
  const scoped = (server: string) => ({ kind: 'application', value: `${scopeNote(server)}\n\n${inAppBrowserNote(server).value}` });

  function nativeThread(o: any = {}) {
    const t = injection({ nativeEnabled: () => true, ...o });
    t.inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    t.inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    return t;
  }

  test("a native thread's first turn carries the in-app browser note once, and again after a compaction", () => {
    const { inj, sessions } = nativeThread({ visibleTools: () => ['sage_files', 'browser_navigate'] });
    const serverName = sessions.get(inj.byThread.get('th')).serverName;
    const ctx = inj.turnContext('th');
    assert.deepEqual(ctx, { key: IN_APP_BROWSER_CONTEXT, context: scoped(serverName) });
    // until the turn went through, the note is offered again
    assert.deepEqual(inj.turnContext('th'), ctx);
    inj.contextForwarded('th', 'some.other.key', inj.contextReceipt('th'));
    assert.deepEqual(inj.turnContext('th'), ctx);
    inj.contextForwarded('th', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th'));
    assert.equal(inj.turnContext('th'), null);
    inj.observe({ method: 'thread/compacted', params: { threadId: 'th' } });
    assert.deepEqual(inj.turnContext('th'), ctx);
    inj.contextForwarded('th', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th'));
    inj.observe({ method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage' } } });
    assert.equal(inj.turnContext('th'), null, 'an ordinary item keeps the note');
    inj.observe({ method: 'item/completed', params: { threadId: 'th' } });
    assert.equal(inj.turnContext('th'), null);
    inj.observe({ method: 'item/completed', params: { threadId: 'th', item: { type: 'contextCompaction' } } });
    assert.deepEqual(inj.turnContext('th'), ctx);
    // a reload starts over
    inj.contextForwarded('th', IN_APP_BROWSER_CONTEXT, inj.contextReceipt('th'));
    inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
    inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th' } });
    inj.observe({ id: 2, result: { thread: { id: 'th' } } });
    assert.deepEqual(inj.turnContext('th'), { key: IN_APP_BROWSER_CONTEXT, context: scoped(serverName) });
  });

  test('no in-app browser note without a native loaded thread, a session, or a browser tool the thread may see: only the Chrome rule', () => {
    const chromeOnly = { key: IN_APP_BROWSER_CONTEXT, context: { kind: 'application', value: chromeSelectionNote(null) } };
    // managed thread, unknown thread, no thread
    const managed = injection({ visibleTools: () => ['browser_navigate'] });
    managed.inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    managed.inj.observe({ id: 1, result: { thread: { id: 'm' } } });
    // a loaded managed thread gets the shared note on what MoPilot's tools reach (#1319 G3), once per load
    assert.match(managed.inj.turnContext('m')?.context.value ?? '', /the browser_\* tools/);
    assert.equal(managed.inj.turnContext('nope'), null);
    assert.equal(managed.inj.turnContext(undefined), null);
    managed.inj.contextForwarded('nope', IN_APP_BROWSER_CONTEXT, managed.inj.contextReceipt('nope'));
    assert.equal(managed.inj.noted.has('nope'), false, 'only a loaded thread is marked');
    managed.inj.contextForwarded('m', IN_APP_BROWSER_CONTEXT, managed.inj.contextReceipt('m'));
    assert.equal(managed.inj.turnContext('m'), null);
    // a native thread without sage-mcp
    const bare = injection({ hasTools: () => false, nativeEnabled: () => true, visibleTools: () => ['browser_navigate'] });
    bare.inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    bare.inj.observe({ id: 1, result: { thread: { id: 'b' } } });
    assert.deepEqual(bare.inj.turnContext('b'), chromeOnly);
    // the default list of visible tools is empty
    assert.deepEqual(nativeThread().inj.turnContext('th'), chromeOnly);
    // a list that fails, or is null, or has no usable browser tool
    assert.deepEqual(
      nativeThread({
        visibleTools: () => {
          throw new Error('registry down');
        },
      }).inj.turnContext('th'),
      chromeOnly,
    );
    assert.deepEqual(nativeThread({ visibleTools: () => null }).inj.turnContext('th'), chromeOnly);
    assert.deepEqual(nativeThread({ visibleTools: () => [7, 'browserless', 'sage_x'] }).inj.turnContext('th'), chromeOnly);
    // the thread's hide filter takes browser_* away
    assert.deepEqual(
      nativeThread({ visibleTools: () => ['browser_navigate'], nativeHide: (n: string) => n.startsWith('browser_') }).inj.turnContext('th'),
      chromeOnly,
    );
    // a filter that does not say true keeps it
    assert.ok(nativeThread({ visibleTools: () => ['browser_navigate'], nativeHide: () => 'yes' }).inj.turnContext('th'));
  });
}
