// MoPilot's tools for the Codex threads of a Host (host/src/codexTools.mjs): each thread Codex starts or resumes is given the portable sage-mcp with a token of its own, the token follows the thread's life, and a thread's calls reach only its chat's app (A: tools through the real shim, W: another chat's app, B: requests left alone, I: thread life, L: a family over the stand-in app-server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCodexTools } from '../host/src/codexTools.mjs';
import { createHostTools } from '../host/src/tools.mjs';
import { createRequire } from 'node:module';

const { chatOfOwner } = createRequire(import.meta.url)('../electron/capabilities/contract/session.cjs');
import { base, installCodex, open, until } from './support/hostCodexKit.ts';

const SHIM = path.join(import.meta.dirname, '..', 'host/bin/sage-mcp.mjs');
const spec = {
  name: 'relay_probe',
  description: 'Probe the app.',
  inputSchema: { type: 'object', properties: {} },
  policy: 'act' as const,
};
const CHATS: Record<string, string> = { 'th-1': 'chat-1', 'th-2': 'chat-2' };

/** The Host's tools, a Codex injector over them, and an app per chat. */
async function world() {
  const tools = createHostTools();
  const socket = await tools.mcp!.socket.listen();
  const injector = createCodexTools({
    sessions: tools.sessions!,
    socketPath: () => socket,
    pidOf: () => process.pid,
    chatOf: (t: string) => CHATS[t] ?? t,
  });
  const app = () => {
    const sent: any[] = [];
    return {
      conn: tools.relay!.attach(
        (m: any) => sent.push(m),
        () => 0,
      ),
      sent,
    };
  };
  /** Start a thread as Codex would: the request goes out with the config, the answer names the thread. */
  const start = (id: number, threadId: string, method = 'thread/start', params: object = {}) => {
    const out = injector.outgoing({ id, method, params: method === 'thread/resume' ? { threadId, ...params } : params });
    injector.observe({ id, result: { thread: { id: threadId } } });
    const [serverName, server]: [string, any] = Object.entries(out.params.config.mcp_servers)[0] as any;
    return { out, serverName, server };
  };
  return { tools, socket, injector, app, start };
}

/** The shim a thread's config starts, as the app-server would start it. */
function mcp(server: any) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } });
  let buffer = '';
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on('data', (c) => {
    buffer += c;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const ask = (method: string, params?: object) =>
    new Promise<any>((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { ask, close: () => child.kill() };
}

test('A: a Codex thread calls the app’s tool through the real sage-mcp, and a thread of another chat reaches its own app', {
  timeout: 60_000,
}, async () => {
  const w = await world();
  try {
    const [a1, a2] = [w.app(), w.app()];
    a1.conn.sync([spec]);
    a2.conn.sync([spec]);
    a1.conn.send('chat-1');
    a2.conn.send('chat-2');
    const t1 = w.start(1, 'th-1');
    const t2 = w.start(2, 'th-2');
    // one server name for every thread (the cached prompt prefix), a token of each thread's own
    assert.equal(t1.serverName, t2.serverName);
    assert.notEqual(t1.server.env.SAGE_MCP_TOKEN, t2.server.env.SAGE_MCP_TOKEN);
    assert.deepEqual([t1.server.command, t1.server.args, t1.server.env.SAGE_MCP_SOCKET], [process.execPath, [SHIM], w.socket]);
    assert.equal(t1.server.default_tools_approval_mode, 'approve');
    const [m1, m2] = [mcp(t1.server), mcp(t2.server)];
    try {
      const listed = await m1.ask('tools/list');
      assert.deepEqual(
        listed.result.tools.map((t: any) => t.name),
        ['relay_probe'],
      );
      const call1 = m1.ask('tools/call', { name: 'relay_probe', arguments: {} });
      await until(() => a1.sent.length);
      assert.equal(a1.sent[0].chatId, 'chat-1');
      assert.equal(a2.sent.length, 0, 'the other chat’s app is not asked');
      a1.conn.result({ chatId: 'chat-1', callId: a1.sent[0].callId, ok: true, content: [{ type: 'text', text: 'one' }] });
      assert.equal((await call1).result.content[0].text, 'one');
      const call2 = m2.ask('tools/call', { name: 'relay_probe', arguments: {} });
      await until(() => a2.sent.length);
      assert.equal(a2.sent[0].chatId, 'chat-2');
      a2.conn.result({ chatId: 'chat-2', callId: a2.sent[0].callId, ok: true, content: [{ type: 'text', text: 'two' }] });
      assert.equal((await call2).result.content[0].text, 'two');
    } finally {
      m1.close();
      m2.close();
    }
  } finally {
    w.tools.close();
  }
});

test('B: a helper thread, other requests, a Host without a socket yet, and a request with no id are left as they are', async () => {
  const w = await world();
  try {
    const start = { id: 1, method: 'thread/start', params: { cwd: '/x' } };
    assert.equal(w.injector.outgoing(start, { helper: true }), start);
    for (const msg of [
      { id: 2, method: 'turn/start', params: {} },
      { id: 3, method: 'thread/resume', params: {} },
      { method: 'thread/start' },
      null,
    ])
      assert.equal(w.injector.outgoing(msg), msg);
    const early = createCodexTools({ sessions: w.tools.sessions!, socketPath: () => null, pidOf: () => null, chatOf: (t: string) => t });
    assert.equal(early.outgoing(start), start);
    assert.equal(w.injector.observe(null), false);
    assert.equal(w.injector.observe({ method: 'thread/closed', params: {} }), false);
    assert.equal(w.injector.observe({ method: 'thread/closed', params: { threadId: 'unknown' } }), false);
    assert.equal(w.injector.setUserServers(), undefined);
    // a request with no params, and an app-server whose process is unknown, still get the server
    const bare = w.injector.outgoing({ id: 10, method: 'thread/start' });
    assert.equal(Object.keys(bare.params.config.mcp_servers).length, 1);
    const unknownPid = createCodexTools({
      sessions: w.tools.sessions!,
      socketPath: () => w.socket,
      pidOf: () => undefined,
      chatOf: (t: string) => t,
    });
    const noPid: any = Object.values(unknownPid.outgoing({ id: 11, method: 'thread/start', params: {} }).params.config.mcp_servers)[0];
    assert.equal(w.tools.sessions!.resolve(noPid.env.SAGE_MCP_TOKEN)!.harnessPid, null);
    // the request's own config survives next to ours
    const kept = w.injector.outgoing({
      id: 9,
      method: 'thread/start',
      params: { config: { model: 'm', mcp_servers: { mine: { command: 'x' } } } },
    });
    assert.equal(kept.params.config.model, 'm');
    assert.deepEqual(Object.keys(kept.params.config.mcp_servers).sort().includes('mine'), true);
    assert.equal(Object.keys(kept.params.config.mcp_servers).length, 2);
  } finally {
    w.tools.close();
  }
});

test('I: the token follows the thread: resume rotates it, close suspends, archive and a failed start end it, and the app-server quitting ends all', async () => {
  const w = await world();
  try {
    const live = (server: any) => !!w.tools.sessions!.resolve(server.env.SAGE_MCP_TOKEN);
    const t1 = w.start(1, 'th-1');
    assert.equal(live(t1.server), true);
    // resume of a thread already loaded: the same session with a new token
    const again = w.start(2, 'th-1', 'thread/resume');
    assert.equal(live(t1.server), false);
    assert.equal(live(again.server), true);
    // closed: the tools stop until the thread is loaded again
    w.injector.observe({ method: 'thread/closed', params: { threadId: 'th-1' } });
    assert.equal(live(again.server), false);
    const back = w.start(3, 'th-1', 'thread/resume');
    assert.equal(live(back.server), true);
    // a resume the app-server refuses leaves the session waiting; a start it refuses ends the one it opened
    const refused = w.injector.outgoing({ id: 4, method: 'thread/resume', params: { threadId: 'th-1' } });
    const refusedServer: any = Object.values(refused.params.config.mcp_servers)[0];
    w.injector.observe({ id: 4, error: { code: -1, message: 'no' } });
    assert.equal(live(refusedServer), false);
    const failedStart: any = Object.values(w.injector.outgoing({ id: 5, method: 'thread/start', params: {} }).params.config.mcp_servers)[0];
    assert.equal(live(failedStart), true);
    w.injector.observe({ id: 5, error: { code: -1, message: 'no' } });
    assert.equal(live(failedStart), false);
    // an answer that names no thread ends what the request opened
    const nameless: any = Object.values(w.injector.outgoing({ id: 6, method: 'thread/fork', params: {} }).params.config.mcp_servers)[0];
    w.injector.observe({ id: 6, result: {} });
    assert.equal(live(nameless), false);
    // a resume of a thread this injector never saw opens a session for it
    const unknownOut = w.injector.outgoing({ id: 7, method: 'thread/resume', params: { threadId: 'th-2' } });
    const unknownServer: any = Object.values(unknownOut.params.config.mcp_servers)[0];
    // before the answer, its calls are already charged to the thread's chat
    assert.equal(chatOfOwner(w.tools.sessions!.resolve(unknownServer.env.SAGE_MCP_TOKEN)!.chatId), 'chat-2');
    w.injector.observe({ id: 7, result: { thread: { id: 'th-2' } } });
    const unknown = { server: unknownServer };
    assert.equal(live(unknown.server), true);
    // archive ends for good
    w.injector.observe({ method: 'thread/archived', params: { threadId: 'th-2' } });
    assert.equal(live(unknown.server), false);
    // the app-server quits: sessions that were waiting for an answer and the ones loaded all end
    const loaded = w.start(8, 'th-1', 'thread/resume');
    const waiting: any = Object.values(w.injector.outgoing({ id: 9, method: 'thread/start', params: {} }).params.config.mcp_servers)[0];
    w.injector.exited();
    assert.deepEqual([live(loaded.server), live(waiting)], [false, false]);
  } finally {
    w.tools.close();
  }
});

test('L: a Codex chat on a Host with tools starts its thread with the sage server in its config; without tools it does not', {
  timeout: 60_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(base, 'l-'));
  const tools = createHostTools();
  const h = await open(dir, installCodex(dir).env, undefined, { tools });
  try {
    await h.call('chat.subscribe', 'chat-l');
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    await h.call('chat.start', 'chat-l', { harness: 'codex', text: 'hello', cwd });
    await until(() => h.requests().some((r) => r.method === 'thread/start'));
    const start = h.requests().find((r) => r.method === 'thread/start');
    const [serverName, server]: [string, any] = Object.entries(start.params.config.mcp_servers)[0] as any;
    assert.match(serverName, /^sage_[0-9a-f]{12}$/);
    assert.deepEqual([server.command, server.args], [process.execPath, [SHIM]]);
    // the thread's token is one of the Host's, and the socket is the Host's tool socket
    assert.equal(!!tools.sessions!.resolve(server.env.SAGE_MCP_TOKEN), true);
    assert.equal(server.env.SAGE_MCP_SOCKET, await tools.mcp!.socket.listen());
  } finally {
    h.close();
    tools.close();
  }
  const dir2 = fs.mkdtempSync(path.join(base, 'l2-'));
  const none = createHostTools({ addon: null });
  const h2 = await open(dir2, installCodex(dir2).env, undefined, { tools: none });
  try {
    await h2.call('chat.subscribe', 'chat-l2');
    await h2.call('chat.start', 'chat-l2', { harness: 'codex', text: 'hello', cwd: dir2 });
    await until(() => h2.requests().some((r) => r.method === 'thread/start'));
    assert.equal(h2.requests().find((r) => r.method === 'thread/start').params.config?.mcp_servers, undefined);
  } finally {
    h2.close();
  }
});
