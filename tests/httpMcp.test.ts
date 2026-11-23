// MoPilot's http tool channel (electron/capabilities/httpMcp.cjs) for a basic harness that takes no stdio MCP
// server, as Copilot CLI does: its peer check, the MCP SDK's own Streamable HTTP client against it, and each refusal,
// cancellation and shutdown. SessionMcp offering it and admission over it: tests/httpMcpSession.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitFor } from './support/waitFor.ts';
import { fakeCore, ancestryOf } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const { ToolHttp, verifyTcpPeer, PATH } = require('../electron/capabilities/httpMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const debugTools = require('../electron/capabilities/tools/debug.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-mcp-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/* -- verifyTcpPeer ------------------------------------------------------ */

/** An execFile stand-in: lsof answers each of `lsof` in turn. */
function exec(lsof: string[]) {
  const calls: string[][] = [];
  const fn = (cmd: string, args: string[], _o: any, cb: any) => {
    calls.push([cmd, ...args]);
    cb(null, lsof.shift() ?? '');
  };
  return { fn, calls };
}
const tcp = { remotePort: 50001, localPort: 4000 };
const held = (pid: number) => `p1\nf9\nn127.0.0.1:4000->127.0.0.1:50001\np${pid}\nf12\nn127.0.0.1:50001->127.0.0.1:4000\n`;
/** A core whose process table is `parents`, pid to parent. */
const table = (parents: Record<number, number> = {}) => fakeCore({ 'caps.ancestry': ancestryOf(parents) }).addon;

test('verifyTcpPeer: no harness pid, no ports, nobody holding the connection', async () => {
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: null }), 'the session has no harness process');
  assert.equal(await verifyTcpPeer({ socket: {}, harnessPid: 5 }), 'no socket');
  // lsof that printed nothing is asked once more
  const e = exec(['', '']);
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 5, execFile: e.fn }), 'the connecting process was not found');
  assert.deepEqual(e.calls[0], ['/usr/sbin/lsof', '-nP', '-iTCP@127.0.0.1:50001', '-sTCP:ESTABLISHED', '-F', 'pn']);
  assert.equal(e.calls.length, 2);
  // only main's own end of it
  assert.equal(
    await verifyTcpPeer({ socket: tcp, harnessPid: 5, execFile: exec(['p1\nf9\nn127.0.0.1:4000->127.0.0.1:50001\n']).fn }),
    'the connecting process was not found',
  );
});

test('verifyTcpPeer: the harness itself or a process it started, found on the second lsof', async () => {
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 50, execFile: exec(['', held(50)]).fn, addon: table() }), null);
  // 70's parent is 60, whose parent is the harness
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 50, execFile: exec([held(70)]).fn, addon: table({ 70: 60, 60: 50 }) }), null);
});

test('verifyTcpPeer: another process, an unreadable parent, a chain past the depth limit', async () => {
  const why = 'process 70 is not the harness or one it started';
  // up to launchd
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 50, execFile: exec([held(70)]).fn, addon: table({ 70: 1 }) }), why);
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 50, execFile: exec([held(70)]).fn, addon: table() }), why);
  const chain: Record<number, number> = {};
  for (let pid = 70; pid < 90; pid++) chain[pid] = pid + 1;
  // eight processes up: 70 to 77
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 77, execFile: exec([held(70)]).fn, addon: table(chain) }), null);
  assert.equal(await verifyTcpPeer({ socket: tcp, harnessPid: 78, execFile: exec([held(70)]).fn, addon: table(chain) }), why);
  // lsof's process line missing: no pid to follow
  assert.equal(
    await verifyTcpPeer({ socket: tcp, harnessPid: 50, execFile: exec(['f12\nn127.0.0.1:50001->127.0.0.1:4000\n']).fn, addon: table() }),
    'process null is not the harness or one it started',
  );
});

/* -- the endpoint ------------------------------------------------------- */

const channels: any[] = [];
after(() => channels.forEach((c) => c.close()));

/** A tool that runs until its call is aborted, saying when it started and how it ended. */
function slowTool() {
  const t = { started: 0, aborted: 0, wake: () => {} };
  const tool = {
    name: 'slow',
    policy: 'observe',
    handler: (_a: any, ctx: any) =>
      new Promise((resolve) => {
        t.started++;
        t.wake();
        ctx.signal.addEventListener('abort', () => (t.aborted++, resolve('stopped')));
      }),
  };
  return { t, tool, started: (n: number) => new Promise<void>((r) => (t.started >= n ? r() : (t.wake = () => t.started >= n && r()))) };
}

async function endpoint(o: any = {}) {
  const sessions = o.sessions ?? new ToolSessions();
  const registry = new Registry();
  registry.register(debugTools.echo);
  const slow = slowTool();
  registry.register(slow.tool);
  const h = new ToolHttp({ sessions, registry, verifyPeer: o.verifyPeer ?? (async () => null) });
  channels.push(h);
  const rejected: string[] = [];
  const connected: any[] = [];
  h.on('rejected', (e: any) => rejected.push(e.reason));
  h.on('connected', (e: any) => connected.push(e));
  const url = await h.listen();
  assert.equal(await h.listen(), url);
  return { h, sessions, url, rejected, connected, slow };
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: any };
/** One request with node:http (Host and Origin as given), its answer parsed. */
function req(url: string, o: { method?: string; headers?: Record<string, string>; body?: any; agent?: http.Agent; path?: string } = {}) {
  const u = new URL(url);
  return new Promise<Res>((resolve, reject) => {
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: o.path ?? u.pathname,
        method: o.method ?? 'POST',
        agent: o.agent,
        headers: { 'Content-Type': 'application/json', ...o.headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null }));
      },
    );
    r.on('error', reject);
    r.end(o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
  });
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test('http: the MCP SDK client initializes, lists and calls tools with the session token; each initialize says hello', async () => {
  const { sessions, url, connected } = await endpoint();
  const { token, serverName } = sessions.open('k', { harnessPid: 1, chatId: 'chat', hide: (n: string) => n === 'slow' });
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+${PATH}$`));
  const client = new Client({ name: 'copilot-like', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(token) } }));
  assert.deepEqual(client.getServerVersion(), { name: serverName, version: '1.0.0' });
  assert.deepEqual(connected, [{ key: 'k', serverName, pid: null }]);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ['sage_debug_echo'],
  );
  assert.deepEqual(await client.callTool({ name: 'sage_debug_echo', arguments: { text: 'hi' } }), {
    content: [{ type: 'text', text: 'echo: hi' }],
    isError: false,
  });
  // a hidden tool is refused as the socket refuses it
  assert.equal((await client.callTool({ name: 'slow', arguments: {} })).isError, true);
  assert.deepEqual(await client.ping(), {});
  await client.close();
});

test('http: initialize gets the revision it asked for when served here, else the newest, and an MCP session id', async () => {
  const { sessions, url } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const init = (id: number, params?: any) =>
    req(url, { headers: bearer(token), body: { jsonrpc: '2.0', id, method: 'initialize', params } });
  const a = await init(1);
  assert.equal(a.body.result.protocolVersion, '2025-11-25');
  assert.equal((await init(2, { protocolVersion: 3 })).body.result.protocolVersion, '2025-11-25');
  assert.equal((await init(3, { protocolVersion: '2099-01-01' })).body.result.protocolVersion, '2025-11-25');
  const b = await init(4, { protocolVersion: '2025-06-18' });
  assert.equal(b.body.result.protocolVersion, '2025-06-18');
  assert.equal(b.headers['content-type'], 'application/json');
  assert.match(String(a.headers['mcp-session-id']), /^[0-9a-f-]{36}$/);
  assert.notEqual(a.headers['mcp-session-id'], b.headers['mcp-session-id']);
  // other answers carry none
  assert.equal(
    (await req(url, { headers: bearer(token), body: { jsonrpc: '2.0', id: 5, method: 'ping' } })).headers['mcp-session-id'],
    undefined,
  );
});

test('http: two MCP clients of one session keep their calls apart, though their request ids are the same', async () => {
  const { sessions, url, slow } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const as = (client: string) => ({ ...bearer(token), 'Mcp-Session-Id': client });
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } };
  const a = req(url, { headers: as('A'), body: call });
  await slow.started(1);
  const b = req(url, { headers: as('B'), body: call });
  await slow.started(2);
  const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } };
  assert.equal((await req(url, { headers: as('A'), body: cancel })).status, 202);
  await a;
  assert.equal(slow.t.aborted, 1, "only A's call stopped");
  assert.equal((await req(url, { headers: as('B'), body: cancel })).status, 202);
  await b;
  assert.equal(slow.t.aborted, 2);
});

test('http: wrong path, a web page, a rebound host, GET and a missing or unknown token are refused', async () => {
  const { sessions, url, rejected } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const port = new URL(url).port;
  assert.equal((await req(url, { path: '/other', headers: bearer(token) })).status, 404);
  assert.equal((await req(url, { headers: { ...bearer(token), Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req(url, { headers: { ...bearer(token), Host: `evil.example:${port}` } })).status, 403);
  // localhost is ours too
  const local = await req(url, {
    headers: { ...bearer(token), Host: `localhost:${port}` },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(local.status, 200);
  const get = await req(url, { method: 'GET', headers: bearer(token) });
  assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
  const none = await req(url, { body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.deepEqual([none.status, none.body.error], [401, { code: -32001, message: 'Not allowed' }]);
  assert.equal((await req(url, { headers: bearer('nope'), body: {} })).status, 401);
  assert.deepEqual(rejected, ['unknown token', 'unknown token']);
});

test('http: an oversized body, broken JSON, a non-object, a response and notifications', async () => {
  const { sessions, url } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const big = await req(url, { headers: bearer(token), body: 'x'.repeat(4 * 1024 * 1024 + 1) }).catch((e) => e);
  // the answer may beat the rest of the upload, or the connection may close under it
  assert.ok(big.status === 413 || big instanceof Error);
  if (big.status) assert.deepEqual(big.body.error, { code: -32600, message: 'Request too large' });
  const broken = await req(url, { headers: bearer(token), body: '{nope' });
  assert.deepEqual([broken.status, broken.body.error.code], [400, -32700]);
  const one = await req(url, { headers: bearer(token), body: 5 });
  assert.deepEqual(one.body, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  // nothing to answer: a response, and notifications
  assert.equal((await req(url, { headers: bearer(token), body: { jsonrpc: '2.0', id: 3, result: {} } })).status, 202);
  const notes = [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
  ];
  assert.equal((await req(url, { headers: bearer(token), body: notes })).status, 202);
  // a batch is answered with a batch
  const batch = await req(url, {
    headers: bearer(token),
    body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, notes[0], { jsonrpc: '2.0', id: 2, method: 'resources/list' }],
  });
  assert.deepEqual(batch.body, [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/list' } },
  ]);
});

test("http: a call whose session left the store while its token works is filed under the token's session", async () => {
  const real = new ToolSessions();
  const sessions: any = Object.assign(new EventEmitter(), {
    resolve: (t: string) => real.resolve(t),
    live: (d: string) => real.live(d),
    get: () => null,
  });
  const { url } = await endpoint({ sessions });
  const { token } = real.open('k', { harnessPid: 1, chatId: 'chat' });
  const r = await req(url, {
    headers: bearer(token),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sage_debug_echo', arguments: { text: 'x' } } },
  });
  assert.equal(r.body.result.content[0].text, 'echo: x');
});

test('http: a request that throws is answered with the error', async () => {
  const { sessions, url } = await endpoint();
  const { token } = sessions.open('k', {
    harnessPid: 1,
    hide: () => {
      throw new Error('rule broke');
    },
  });
  const r = await req(url, { headers: bearer(token), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.deepEqual(r.body.error, { code: -32603, message: 'rule broke' });
});

test('http: the peer is checked once per connection and session; a refused or failing check is refused', async () => {
  let checks = 0;
  let why: string | null = null;
  const { sessions, url, rejected } = await endpoint({
    verifyPeer: async ({ harnessPid }: any) => {
      checks++;
      if (harnessPid === 3) throw new Error('the check broke');
      return why;
    },
  });
  const a = sessions.open('a', { harnessPid: 1 });
  const b = sessions.open('b', { harnessPid: 2 });
  const c = sessions.open('c', { harnessPid: 3 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await req(url, { agent, headers: bearer(a.token), body: ping })).status, 200);
  assert.equal((await req(url, { agent, headers: bearer(a.token), body: ping })).status, 200);
  assert.equal(checks, 1);
  // another session on the same connection is checked for itself
  why = 'process 9 is not the harness or one it started';
  assert.equal((await req(url, { agent, headers: bearer(b.token), body: ping })).status, 403);
  assert.equal((await req(url, { agent, headers: bearer(c.token), body: ping })).status, 403);
  assert.equal(checks, 3);
  assert.deepEqual(rejected, [why, 'the check broke']);
  agent.destroy();
});

test('http: a token rotated while its peer was checked is refused', async () => {
  let release = (_v: null) => {};
  let checking = () => {};
  const asked = new Promise<void>((r) => (checking = r));
  const sessions = new ToolSessions();
  const { url, rejected } = await endpoint({
    sessions,
    verifyPeer: () => new Promise<null>((r) => ((release = r), checking())),
  });
  const { token } = sessions.open('k', { harnessPid: 1 });
  const pending = req(url, { headers: bearer(token), body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  await asked;
  sessions.rotate('k');
  release(null);
  assert.equal((await pending).status, 401);
  assert.deepEqual(rejected, ['token revoked']);
});

test('http: a call stops on notifications/cancelled, on the session ending, and when the harness hangs up', async () => {
  const { sessions, url, slow } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  // cancelled by id, from another request
  const first = req(url, { headers: bearer(token), body: call(7) });
  await slow.started(1);
  const note = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } };
  assert.equal((await req(url, { headers: bearer(token), body: note })).status, 202);
  const res = await first;
  assert.equal(res.body.id, 7);
  assert.equal(res.body.result.isError, true);
  assert.equal(slow.t.aborted, 1);
  // the session ends: its calls stop, and a session with none in flight ends quietly
  const second = req(url, { headers: bearer(token), body: call(8) });
  await slow.started(2);
  sessions.open('idle', { harnessPid: 1 });
  sessions.end('idle');
  sessions.end('k');
  assert.equal((await second).body.result.isError, true);
  assert.equal(slow.t.aborted, 2);
  // the harness hangs up mid-call: the call stops; the batch's other members are no calls to stop
  const { token: t2 } = sessions.open('k2', { harnessPid: 1 });
  const u = new URL(url);
  const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: bearer(t2) });
  r.on('error', () => {});
  r.end(JSON.stringify([call(9), call(10), { jsonrpc: '2.0', id: 11, method: 'ping' }, 5, { jsonrpc: '2.0', method: 'tools/call' }]));
  await slow.started(4);
  r.destroy();
  while (slow.t.aborted < 4) await new Promise((res2) => setTimeout(res2, 5));
  assert.equal(slow.t.aborted, 4);
  // a hang-up stops only the calls of the request hung up on, not a later call that reused its id
  const r2 = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: bearer(t2) });
  r2.on('error', () => {});
  r2.end(JSON.stringify(call(12)));
  await slow.started(5);
  const reused = req(url, { headers: bearer(t2), body: call(12) });
  await slow.started(6);
  r2.destroy();
  while (slow.t.aborted < 5) await new Promise((res2) => setTimeout(res2, 5));
  await new Promise((res2) => setTimeout(res2, 30));
  assert.equal(slow.t.aborted, 5, 'the reused id keeps running');
  sessions.end('k2');
  assert.equal((await reused).body.result.isError, true);
  assert.equal(slow.t.aborted, 6);
});

test('http: close stops the calls in flight; listening again opens a new endpoint', async () => {
  const { h, sessions, url, slow } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const pending = req(url, {
    headers: bearer(token),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } },
  }).catch((e) => e);
  await slow.started(1);
  h.close();
  await pending;
  assert.equal(slow.t.aborted, 1);
  assert.equal(h.server, null);
  const again = await h.listen();
  assert.match(again, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  h.close();
  h.close();
});

test('http: closed while opening, or a listen error, rejects; an error once listening is noted', async () => {
  clearIgnored();
  const h = new ToolHttp({ sessions: new ToolSessions(), registry: new Registry() });
  channels.push(h);
  const opening = h.listen();
  h.close();
  await assert.rejects(opening, /closed while opening/);
  const failing = h.listen();
  h.server.emit('error', new Error('EADDRINUSE'));
  await assert.rejects(failing, /EADDRINUSE/);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.listening, null);
  await h.listen();
  h.server.emit('error', new Error('later'));
  assert.ok(recentIgnored().some((e: any) => /later/.test(e.message)));
  // an old attempt's failure leaves a newer one alone
  h.close();
  const old = h.listen();
  h.server.emit('error', new Error('old'));
  h.listening = Promise.resolve('newer');
  await assert.rejects(old);
  await new Promise((r) => setImmediate(r));
  assert.equal(await h.listening, 'newer');
});

test('http: a request whose upload breaks off is dropped and noted', async () => {
  clearIgnored();
  const { sessions, url } = await endpoint();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const u = new URL(url);
  const r = http.request({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: { ...bearer(token), 'Content-Length': '100' },
  });
  r.on('error', () => {});
  r.write('{"jsonrpc"');
  await new Promise((res) => setTimeout(res, 50));
  r.destroy();
  await waitFor(() => recentIgnored().some((e: any) => /answer a harness over http/.test(e.context)), 'the ignored error to be logged');
  assert.ok(recentIgnored().some((e: any) => /answer a harness over http/.test(e.context)));
});

test('the http channel is a ToolSessions listener only while it listens', async () => {
  const sessions = new ToolSessions();
  const h = new ToolHttp({ sessions, registry: new Registry() });
  channels.push(h);
  // closing one that never listened is fine
  h.close();
  assert.equal(sessions.listenerCount('revoked'), 0);
  await h.listen();
  await h.listen();
  assert.equal(sessions.listenerCount('revoked'), 1);
  h.close();
  assert.equal(sessions.listenerCount('revoked'), 0);
});
