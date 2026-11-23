// electron/capabilities/channels/codexConfig.cjs: the per-thread config fragment that gives a Codex
// thread sage-mcp, and the session lifecycle main follows from the app-server's traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

test('the injection reads the user servers the adapter hands it', () => {
  const { inj } = setup();
  const cfg = (m: any) => m.params.config.mcp_servers;
  assert.equal('node_repl' in cfg(inj.outgoing({ id: 1, method: 'thread/start', params: {} })), false);
  inj.setUserServers(['node_repl']);
  assert.deepEqual(cfg(inj.outgoing({ id: 2, method: 'thread/start', params: {} })).node_repl, { enabled: false });
});

function setup(hasTools = true) {
  const sessions = new ToolSessions();
  let pid = 100;
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => pid,
    hasTools: () => hasTools,
  });
  const serverOf = (msg: any) => {
    const names = Object.keys(msg.params.config?.mcp_servers || {});
    return names.length ? { name: names[0], token: msg.params.config.mcp_servers[names[0]].env.SAGE_MCP_TOKEN } : null;
  };
  return { sessions, inj, serverOf, setPid: (p: number) => (pid = p) };
}

test('thread/start gets a session bound to the new thread id once the app-server answers', () => {
  const { sessions, inj, serverOf } = setup();
  const sent = inj.outgoing({ id: 1, method: 'thread/start', params: { cwd: '/w', config: { model_reasoning_effort: 'low' } } });
  const s = serverOf(sent)!;
  assert.match(s.name, /^sage_[0-9a-f]{12}$/);
  assert.equal(sent.params.config.model_reasoning_effort, 'low');
  assert.equal(sent.params.config.plugins['unified-computer-use@openai-bundled'].enabled, false);
  assert.equal(sessions.resolve(s.token).harnessPid, 100);
  assert.equal(inj.observe({ id: 1, result: { thread: { id: 'th-1' } } }), false);
  const live = sessions.resolve(s.token);
  assert.deepEqual([live.chatId, live.segmentId], ['th-1', 'th-1']);
  // other requests pass through untouched
  const turn = { id: 2, method: 'turn/start', params: { threadId: 'th-1' } };
  assert.equal(inj.outgoing(turn), turn);
});

test('resume rotates the token (same name); a loaded thread keeps the server it has', () => {
  const { sessions, inj, serverOf, setPid } = setup();
  const first = serverOf(inj.outgoing({ id: 1, method: 'thread/start', params: {} }))!;
  inj.observe({ id: 1, result: { thread: { id: 'th-1' } } });
  // already loaded: the same server and token again (Codex may respawn the thread from this config, #2500)
  const again = serverOf(inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th-1' } }))!;
  assert.deepEqual(again, first);
  assert.ok(sessions.resolve(first.token));
  // Codex unloads it; the next resume starts a new sage-mcp with a new token
  inj.observe({ method: 'thread/closed', params: { threadId: 'th-1' } });
  assert.equal(sessions.resolve(first.token), null);
  setPid(200);
  const second = serverOf(inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th-1' } }))!;
  assert.equal(second.name, first.name);
  assert.notEqual(second.token, first.token);
  assert.equal(sessions.resolve(second.token).harnessPid, 200);
  inj.observe({ id: 3, result: { thread: { id: 'th-1' } } });
  // the app-server exits: every thread's session ends, not just its token; the resume after it opens a new one
  const secondKey = sessions.resolve(second.token).key;
  inj.exited();
  assert.equal(sessions.resolve(second.token), null);
  assert.equal(sessions.get(secondKey), null);
  const third = serverOf(inj.outgoing({ id: 4, method: 'thread/resume', params: { threadId: 'th-1' } }))!;
  assert.deepEqual([third.name === first.name, third.token !== second.token], [true, true]); // shared name (#2579), a token of its own
  assert.ok(sessions.resolve(third.token));
  assert.equal(sessions.resolve(second.token), null);
});

test('a thread Sage never started gets a session on its first resume; archiving ends it', () => {
  const { sessions, inj, serverOf } = setup();
  const s = serverOf(inj.outgoing({ id: 1, method: 'thread/resume', params: { threadId: 'old' } }))!;
  inj.observe({ id: 1, result: { thread: { id: 'old' } } });
  assert.equal(sessions.resolve(s.token).chatId, 'old');
  inj.observe({ method: 'thread/archived', params: { threadId: 'old' } });
  assert.equal(sessions.resolve(s.token), null);
  // unarchived and resumed later: a new session with a new token (the name is the shared one, #2579)
  const next = serverOf(inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'old' } }))!;
  assert.deepEqual([next.name === s.name, next.token !== s.token], [true, true]);
});

test('a failed thread/start ends its session; no tools means no injection', () => {
  const { sessions, inj, serverOf } = setup();
  const s = serverOf(inj.outgoing({ id: 1, method: 'thread/start', params: {} }))!;
  inj.observe({ id: 1, error: { code: -32600, message: 'nope' } });
  assert.equal(sessions.resolve(s.token), null);
  const none = setup(false);
  const msg = { id: 1, method: 'thread/start', params: {} };
  assert.equal(none.inj.outgoing(msg), msg);
});

test('D-1: a thread of a chat that switched harness is logged and aborted under the chat, not the segment', () => {
  const sessions = new ToolSessions();
  const chats: Record<string, string> = { seg2: 'chat1' };
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    chatOf: (id: string) => chats[id] ?? id,
  });
  const start = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  const token = (m: any) => Object.values(m.params.config.mcp_servers as any)[0] as any;
  inj.observe({ id: 1, result: { thread: { id: 'seg2' } } });
  assert.deepEqual(
    [sessions.resolve(token(start).env.SAGE_MCP_TOKEN).chatId, sessions.resolve(token(start).env.SAGE_MCP_TOKEN).segmentId],
    ['chat1', 'seg2'],
  );
  // a thread no chat claims is its own chat
  const other = inj.outgoing({ id: 2, method: 'thread/start', params: {} });
  inj.observe({ id: 2, result: { thread: { id: 'solo' } } });
  assert.equal(sessions.resolve(token(other).env.SAGE_MCP_TOKEN).chatId, 'solo');
  // a switch starts the thread before the chat records it: the owner is looked up at each call, so the
  // calls after the switch commits its segment belong to the chat (docs/control-plane/matrix.md CM-O02)
  const switched = inj.outgoing({ id: 3, method: 'thread/start', params: {} });
  inj.observe({ id: 3, result: { thread: { id: 'seg3' } } });
  const live = token(switched).env.SAGE_MCP_TOKEN;
  assert.equal(sessions.resolve(live).chatId, 'seg3');
  chats.seg3 = 'chat2';
  assert.equal(sessions.resolve(live).chatId, 'chat2');
  // and a resume that opens a session for an unknown thread does the same
  const resumed = inj.outgoing({ id: 4, method: 'thread/resume', params: { threadId: 'seg4' } });
  const resumedToken = token(resumed).env.SAGE_MCP_TOKEN;
  assert.equal(sessions.resolve(resumedToken).chatId, 'seg4');
  chats.seg4 = 'chat2';
  assert.equal(sessions.resolve(resumedToken).chatId, 'chat2');
});

test('an elicitation from cua_repl is declined, noted once per thread, and never reaches the windows', () => {
  const { rejectNativeCuaElicitation } = require('../electron/capabilities/contract/serverRequests.cjs');
  const sent: any[] = [];
  const notes: string[] = [];
  const h = rejectNativeCuaElicitation({ send: (m: any) => sent.push(m), notify: (t: string, x: string) => notes.push(`${t}:${x}`) });
  const req = (id: number, serverName: string, threadId = 't1') => ({
    id,
    method: 'mcpServer/elicitation/request',
    params: { threadId, serverName, mode: 'form', message: 'm' },
  });
  assert.equal(h(req(1, 'cua_repl')), true);
  assert.equal(h(req(2, 'cua_repl')), true);
  assert.deepEqual(sent, [
    { id: 1, result: { action: 'decline', content: null, _meta: null } },
    { id: 2, result: { action: 'decline', content: null, _meta: null } },
  ]);
  assert.equal(notes.length, 1);
  assert.equal(h(req(3, 'cua_repl', 't2')), true);
  assert.equal(notes.length, 2);
  assert.equal(h(req(4, 'codex_apps')), false);
  assert.equal(h({ id: 5, method: 'item/tool/call', params: {} }), false);
});

test('a thread MoPilot runs itself (title, handoff, probe) gets native control off but no sage-mcp session', () => {
  const { sessions, inj } = setup();
  inj.setUserServers(['node_repl']);
  const start = inj.outgoing({ id: 1, method: 'thread/start', params: { ephemeral: true, config: { model: 'm' } } }, { helper: true });
  assert.deepEqual(start.params.config, {
    model: 'm',
    mcp_servers: { node_repl: { enabled: false } },
    plugins: { 'unified-computer-use@openai-bundled': { enabled: false } },
  });
  const fork = inj.outgoing({ id: 2, method: 'thread/fork', params: { threadId: 'th-1', ephemeral: true } }, { helper: true });
  assert.equal(
    Object.keys(fork.params.config.mcp_servers).some((n: string) => n.startsWith('sage_')),
    false,
  );
  // nothing waits on the answer, and no session was opened
  assert.equal(inj.observe({ id: 1, result: { thread: { id: 'th-helper' } } }), false);
  assert.equal(sessions.byKey.size, 0);
  const turn = { id: 3, method: 'turn/start', params: { threadId: 'th-helper' } };
  assert.equal(inj.outgoing(turn, { helper: true }), turn);
});

test('a helper thread starts none of the user MCP servers: each loaded thread keeps its own until the app-server exits', () => {
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 100,
    hasTools: () => true,
    disableUserNodeRepl: () => false,
  });
  inj.setUserServers(['node_repl', 'rea', 'github']);
  for (const method of ['thread/start', 'thread/fork']) {
    const msg = inj.outgoing({ id: 1, method, params: { threadId: 'th-1', ephemeral: true } }, { helper: true });
    assert.deepEqual(msg.params.config.mcp_servers, {
      node_repl: { enabled: false },
      rea: { enabled: false },
      github: { enabled: false },
    });
  }
  // a chat's own thread keeps them (the user's node_repl stays on with the setting off)
  const own = inj.outgoing({ id: 2, method: 'thread/start', params: {} });
  assert.equal(own.params.config.mcp_servers.rea, undefined);
  assert.equal(own.params.config.mcp_servers.node_repl, undefined);
});

/* ------------------------------------------- the plugin's in-app browser backend (iabBackend.cjs) */

const { inAppBrowserNote, scopeNote } = require('../electron/capabilities/channels/codexConfig.cjs');

function withBackends(o: any = {}) {
  const calls: any[] = [];
  const backends: any = {
    on: true,
    available: () => {
      if (backends.on === 'throw') throw new Error('x');
      return backends.on;
    },
    // a thread has its backend once it was loaded with one available
    has: (id: string) => {
      if (backends.on === 'throw') throw new Error('x');
      return backends.on === true && calls.some((c) => c[0] === 'loaded' && c[1] === id);
    },
    loaded: (id: string, opts?: any) => {
      calls.push(opts ? ['loaded', id, opts] : ['loaded', id]);
      if (backends.fail === 'sync') throw new Error('x');
      return backends.fail === 'async' ? Promise.reject(new Error('x')) : Promise.resolve('/tmp/x.sock');
    },
    unloaded: (id: string) => calls.push(['unloaded', id]),
    exited: () => calls.push(['exited']),
  };
  const sessions = new ToolSessions();
  let native = true;
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => native,
    visibleTools: () => ['browser_navigate'],
    browserBackends: backends,
    ...o,
  });
  let id = 0;
  const load = (threadId: string, method = 'thread/start') => {
    const rid = ++id;
    const sent = inj.outgoing({ id: rid, method, params: method === 'thread/resume' ? { threadId } : {} });
    inj.observe({ id: rid, result: { thread: { id: threadId } } });
    return sent;
  };
  return { inj, calls, backends, load, setNative: (v: boolean) => (native = v) };
}

test('a native thread starts its in-app browser backend; unload, a managed reload and the app-server exit stop it', () => {
  const { inj, calls, load, setNative } = withBackends();
  load('th');
  assert.deepEqual(calls, [['loaded', 'th', { surfaces: { chrome: true, computer: true } }]]);
  inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
  assert.deepEqual(calls.at(-1), ['unloaded', 'th']);
  setNative(false);
  load('th', 'thread/resume');
  assert.deepEqual(calls.at(-1), ['unloaded', 'th']);
  inj.exited();
  assert.deepEqual(calls.at(-1), ['exited']);
});

test("a backend that fails to start doesn't disturb the app-server traffic", async () => {
  const { inj, backends, load } = withBackends();
  backends.fail = 'sync';
  load('a');
  backends.fail = 'async';
  load('b');
  await new Promise((r) => setImmediate(r));
  assert.equal(inj.isNativeThread('a'), true);
  assert.equal(inj.isNativeThread('b'), true);
});

test('with the backend the routing note names iab as the pane (and Chrome when native); without it, the old note', () => {
  const { inj, backends, load } = withBackends({ nativeSurfaces: () => ({ chrome: true, computer: true }) });
  const sent = load('th');
  const server = Object.keys(sent.params.config.mcp_servers).find((n) => n.startsWith('sage_'))!;
  const value = inj.turnContext('th').context.value;
  assert.equal(value, `${scopeNote(server)}\n\n${inAppBrowserNote(server, true, true).value}`);
  assert.match(value, /"iab" backend/);
  assert.match(value, /Chrome backend drives the browser the ChatGPT extension is connected to/);
  assert.match(value, new RegExp(`browser_\\* tools of the ${server} MCP server drive the same pane`));
  assert.doesNotMatch(inAppBrowserNote(server, false, true).value, /Chrome/);
  backends.on = 'throw';
  inj.observe({ method: 'thread/compacted', params: { threadId: 'th' } });
  assert.equal(inj.turnContext('th').context.value, `${scopeNote(server)}\n\n${inAppBrowserNote(server, true).value}`);
  assert.match(inAppBrowserNote(server, true).value, /is not available in MoPilot/);
});

test('hasThread: a Codex thread this injection serves (a subagent answers for its parent), and the Chrome its plugin drives', () => {
  const chromeOn = withBackends({ nativeSurfaces: () => ({ chrome: true, computer: false }) });
  chromeOn.load('th');
  assert.equal(chromeOn.inj.hasThread('th'), true);
  assert.equal(chromeOn.inj.hasThread('other'), false);
  assert.equal(chromeOn.inj.loadedPath('th')?.chrome, true);
  // a subagent answers for its parent
  chromeOn.inj.observe({ method: 'thread/started', params: { thread: { id: 'sub-1', parentThreadId: 'th' } } });
  assert.equal(chromeOn.inj.hasThread('sub-1'), true);
  // the plugin can't serve Chrome on this Mac: Your Chrome's tools stay
  const chromeOff = withBackends({ nativeSurfaces: () => ({ chrome: false, computer: true }) });
  chromeOff.load('th');
  assert.equal(chromeOff.inj.loadedPath('th')?.chrome, false);
});

test("a native thread's subagents get their own backend over the parent's chat, and go with it", () => {
  const { inj, calls, load } = withBackends();
  load('th');
  load('managed');
  inj.observe({ method: 'thread/closed', params: { threadId: 'managed' } });
  calls.length = 0;
  // thread/started names the parent (the field, or the subagent source)
  inj.observe({ method: 'thread/started', params: { thread: { id: 'sub-1', parentThreadId: 'th' } } });
  inj.observe({
    method: 'thread/started',
    params: { thread: { id: 'sub-2', source: { subAgent: { thread_spawn: { parent_thread_id: 'th', depth: 1 } } } } },
  });
  // a collab tool call names its receivers; a nested subagent works in the root's chat
  inj.observe({
    method: 'item/started',
    params: { threadId: 'sub-1', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['sub-3'] } },
  });
  inj.observe({ method: 'item/completed', params: { threadId: 'th', item: { type: 'collabAgentToolCall' } } });
  assert.deepEqual(calls, [
    ['loaded', 'sub-1', { parent: 'th', surfaces: { chrome: true, computer: true } }],
    ['loaded', 'sub-2', { parent: 'th', surfaces: { chrome: true, computer: true } }],
    ['loaded', 'sub-3', { parent: 'th', surfaces: { chrome: true, computer: true } }],
  ]);
  assert.equal(inj.isNativeThread('sub-3'), true);
  assert.equal(inj.chatThreadOf('sub-3'), 'th');
  assert.equal(inj.chatThreadOf('th'), 'th');
  // not adopted: seen already, the parent itself, no id, a parent that is not native, or a thread with no parent
  inj.observe({ method: 'thread/started', params: { thread: { id: 'sub-1', parentThreadId: 'th' } } });
  inj.observe({
    method: 'item/started',
    params: { threadId: 'th', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['th', ''] } },
  });
  inj.observe({ method: 'thread/started', params: { thread: { id: 'm-sub', parentThreadId: 'managed' } } });
  inj.observe({ method: 'thread/started', params: { thread: { id: 'top' } } });
  inj.observe({ method: 'thread/started', params: {} });
  inj.observe({ method: 'item/started', params: { threadId: 'th', item: { type: 'agentMessage' } } });
  inj.observe({ method: 'item/started', params: { threadId: 'th' } });
  assert.equal(calls.length, 3);
  assert.equal(inj.isNativeThread('m-sub'), false);
  // a subagent closing stops its own backend; the parent closing stops the rest
  inj.observe({ method: 'thread/closed', params: { threadId: 'sub-2' } });
  assert.deepEqual(calls.at(-1), ['unloaded', 'sub-2']);
  inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
  assert.deepEqual(calls.slice(-3), [
    ['unloaded', 'sub-1'],
    ['unloaded', 'sub-3'],
    ['unloaded', 'th'],
  ]);
  assert.equal(inj.isNativeThread('sub-1'), false);
  load('th', 'thread/resume');
  inj.observe({ method: 'thread/started', params: { thread: { id: 'sub-4', parentThreadId: 'th' } } });
  inj.exited();
  assert.equal(inj.subagents.size, 0);
});

test('without browser backends the injection behaves as before', () => {
  const { inj, load } = withBackends({ browserBackends: undefined });
  load('th');
  inj.observe({ method: 'thread/deleted', params: { threadId: 'th' } });
  inj.exited();
  assert.equal(inj.isNativeThread('th'), false);
});

test('collaboration messages cannot adopt a native root or unrelated threads', () => {
  const { inj, calls, load } = withBackends();
  load('root');
  load('other');
  inj.observe({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root' } } });
  calls.length = 0;
  for (const tool of ['sendMessage', 'wait', 'closeAgent', 'resumeAgent']) {
    inj.observe({
      method: 'item/completed',
      params: {
        threadId: 'child',
        item: { type: 'collabAgentToolCall', tool, receiverThreadIds: ['root', 'other', 'unloaded-other'] },
      },
    });
  }
  assert.equal(inj.subagents.has('root'), false);
  assert.equal(inj.subagents.has('other'), false);
  assert.equal(inj.subagents.has('unloaded-other'), false);
  assert.equal(inj.isNativeThread('root'), true);
  assert.equal(inj.chatThreadOf('other'), 'other');
  assert.deepEqual(calls, []);
});

test('explicitly loaded threads cannot be reparented by spawn or parent notifications', () => {
  const { inj, load, setNative } = withBackends();
  load('root');
  setNative(false);
  load('managed');
  inj.observe({ method: 'thread/started', params: { thread: { id: 'managed', parentThreadId: 'root' } } });
  inj.observe({
    method: 'item/started',
    params: {
      threadId: 'root',
      item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['managed'] },
    },
  });
  assert.equal(inj.subagents.has('managed'), false);
  assert.equal(inj.isNativeThread('managed'), false);
  assert.equal(inj.chatThreadOf('managed'), 'managed');
});

test('a parent notification from a nested child cannot adopt the native root', () => {
  const { inj, load } = withBackends();
  load('root');
  inj.observe({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root' } } });
  inj.observe({ method: 'thread/started', params: { thread: { id: 'root', parentThreadId: 'child' } } });
  assert.equal(inj.subagents.has('root'), false);
  assert.equal(inj.isNativeThread('root'), true);
});

test('a note that names MoPilot tools says first that it applies only while their server is in the tool list (thread continued in the ChatGPT app)', () => {
  const server = 'sage_0123456789ab';
  const scope = scopeNote(server);
  // names the server it depends on, says what to do without it, and points back to the plugin's own iab
  assert.match(scope, new RegExp(`only while the ${server} MCP server is in your tool list`));
  assert.match(scope, /If it is not in your tool list, ignore the parts below/);
  assert.match(scope, /in-app browser \("iab"\)/);
  for (const chrome of [true, false]) {
    for (const iab of [true, false]) {
      const { inj, backends, load } = withBackends({ nativeSurfaces: () => ({ chrome, computer: true }) });
      backends.on = iab ? true : 'throw';
      const name = Object.keys(load('th').params.config.mcp_servers).find((n) => n.startsWith('sage_'))!;
      const value = inj.turnContext('th').context.value;
      assert.ok(value.startsWith(scopeNote(name)), `the routing note starts with the scope note (chrome ${chrome}, iab ${iab})`);
      assert.equal(value.split(scopeNote(name)).length, 2, 'once');
    }
  }
});

test('the Chrome selection rule alone carries no scope note: it does not depend on MoPilot', () => {
  const { inj, load } = withBackends({ visibleTools: () => ['desktop_click'], nativeSurfaces: () => ({ chrome: true, computer: true }) });
  load('th');
  assert.doesNotMatch(inj.turnContext('th').context.value, /applies only while/);
});
