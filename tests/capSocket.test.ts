// The sage-mcp socket without a real sage-mcp: the peer check over a fake core's answers, and the
// socket's framing, hello and request handling over plain connections with a stand-in peer check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { fakeCore, ancestryOf } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const { ToolSocket, verifyPeer, callToolResult } = require('../electron/capabilities/mcp/socket.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

/* -- verifyPeer -------------------------------------------------------- */
const sock = (fd: any) => ({ _handle: fd === undefined ? null : { fd } });
/** A core whose table is `tree` (pid to parent) and whose kernel names `peer`. */
const addon = (tree: Record<number, number>, peer: unknown = 50) =>
  fakeCore({ 'caps.ancestry': ancestryOf(tree), 'caps.peerPid': peer }).addon;

test('verifyPeer: no pid, no harness pid, an unreadable parent', async () => {
  assert.equal(await verifyPeer({ socket: sock(3), pid: 1, harnessPid: 5 }), 'no pid');
  assert.equal(await verifyPeer({ socket: sock(3), pid: 'x', harnessPid: 5 }), 'no pid');
  assert.equal(await verifyPeer({ socket: sock(3), pid: 50, harnessPid: null }), 'the session has no harness process');
  assert.equal(
    await verifyPeer({ socket: sock(3), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({}) }),
    'process 50 is not one the harness started',
  );
  assert.equal(
    await verifyPeer({ socket: sock(3), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 6 }) }),
    'process 50 is not one the harness started',
  );
});

test('verifyPeer: a process the harness started further down (an ACP adapter runs the CLI that starts sage-mcp, #1320) passes the ancestry check; the harness itself, a stranger or a loop does not', async () => {
  // sage-mcp 50 <- the CLI 40 <- the ACP adapter 5
  assert.equal(await verifyPeer({ socket: sock(7), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 40, 40: 5 }) }), null);
  assert.equal(
    await verifyPeer({ socket: sock(7), pid: 5, harnessPid: 5, platform: 'darwin', addon: addon({ 5: 1 }) }),
    'process 5 is not one the harness started',
  );
  assert.equal(
    await verifyPeer({ socket: sock(7), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 40, 40: 30, 30: 1 }) }),
    'process 50 is not one the harness started',
  );
  // a loop in what the table reads ends
  assert.equal(
    await verifyPeer({ socket: sock(7), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 60, 60: 50 }) }),
    'process 50 is not one the harness started',
  );
});

test('verifyPeer: no socket handle or a closed one', async () => {
  assert.equal(
    await verifyPeer({ socket: sock(undefined), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 5 }) }),
    'no socket',
  );
  assert.equal(await verifyPeer({ socket: sock(-1), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 5 }) }), 'no socket');
});

test('verifyPeer: the kernel must name the claimed process', async () => {
  const check = (peer: unknown) =>
    verifyPeer({ socket: sock(7), pid: 50, harnessPid: 5, platform: 'darwin', addon: addon({ 50: 5 }, peer) });
  assert.equal(await check(50), null);
  assert.equal(await check(new Error('not connected')), 'socket not found');
  assert.equal(await check(51), 'process 50 is not the one connected');
});

test('callToolResult: a result without content', () => {
  assert.deepEqual(callToolResult({ ok: true }), { content: [], isError: false });
});

test('callToolResult: a result that ends the turn carries Claude Code’s end-turn flag; a failure never does', () => {
  const content = [{ type: 'text', text: '{}' }];
  assert.deepEqual(callToolResult({ ok: true, content, endsTurn: true }), { content, isError: false, _meta: { 'claude/endTurn': true } });
  assert.deepEqual(callToolResult({ ok: false, content: [], endsTurn: true, error: { message: 'no' } }), {
    content: [{ type: 'text', text: 'no' }],
    isError: true,
  });
});

/* -- the socket ------------------------------------------------------- */
const sockets: any[] = [];
after(() => sockets.forEach((s) => s.close()));

async function server(o: any = {}) {
  const sessions = o.sessions ?? new ToolSessions();
  const registry = new Registry();
  registry.register({ name: 'echo', policy: 'observe', handler: (a: any) => `echo ${JSON.stringify(a)} ${o.seen ? o.seen() : ''}` });
  const s = new ToolSocket({ sessions, registry, verifyPeer: o.verifyPeer ?? (async () => null), helloTimeoutMs: o.helloTimeoutMs });
  sockets.push(s);
  const rejected: string[] = [];
  s.on('rejected', (e: any) => rejected.push(e.reason));
  const file = await s.listen();
  assert.equal(await s.listen(), file);
  return { s, sessions, file, rejected };
}

/** A plain client: send lines, read replies in order. */
function client(file: string) {
  const c = net.createConnection(file);
  c.setEncoding('utf8');
  let buf = '';
  const replies: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  let closed = false;
  const closedP = new Promise<void>((r) => c.on('close', () => ((closed = true), r())));
  c.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(m);
      else replies.push(m);
    }
  });
  c.on('error', () => {});
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise<any>((r) => waiters.push(r)));
  const send = (m: any) => c.write(typeof m === 'string' ? m : JSON.stringify(m) + '\n');
  return { c, next, send, closedP, isClosed: () => closed };
}

test('socket: broken JSON and non-object requests are refused, then hello and requests work', async (t) => {
  const { sessions, file } = await server();
  const { token } = sessions.open('k', { harnessPid: 1 });
  const cl = client(file);
  t.after(() => cl.c.destroy());
  cl.send('\n\nnot json\n');
  assert.deepEqual(await cl.next(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const nonRecords = ['null', '[]', '1', 'true', '"text"'];
  cl.send({ id: 1, method: 'hello', params: { token, pid: 9 } });
  assert.equal((await cl.next()).result.serverName, sessions.get('k').serverName);
  for (const line of nonRecords) {
    cl.send(line + '\n');
    assert.deepEqual(await cl.next(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  cl.send({ method: 'notifications/initialized' });
  cl.send({ id: 2, method: 'tools/call', params: { name: 'echo' } });
  assert.deepEqual((await cl.next()).result, { content: [{ type: 'text', text: 'echo {} ' }], isError: false });
  cl.send({ id: 3, method: 'tools/call' });
  assert.equal((await cl.next()).result.isError, true);
  cl.send({ id: 4, method: 'resources/list' });
  assert.deepEqual((await cl.next()).error, { code: -32601, message: 'Method not found: resources/list' });
  cl.c.destroy();
});

test('socket: a call after the session ended is refused and the connection closed', async () => {
  // a session store whose token stays resolvable but stops being live after the hello
  const real = new ToolSessions();
  let live = true;
  const sessions: any = Object.assign(new EventEmitter(), {
    resolve: (t: string) => real.resolve(t),
    live: (d: string) => live && real.live(d),
    get: () => null,
  });
  const { file } = await server({ sessions });
  const { token } = real.open('k', { harnessPid: 1, chatId: 'chat' });
  const cl = client(file);
  cl.send({ id: 1, method: 'hello', params: { token, pid: 9 } });
  await cl.next();
  // the session is gone from the store: the call is filed under the hello's chat and segment
  cl.send({ id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.equal((await cl.next()).result.content[0].text, 'echo {"a":1} ');
  live = false;
  cl.send({ id: 3, method: 'tools/list' });
  assert.deepEqual((await cl.next()).error, { code: -32001, message: 'Not allowed' });
  await cl.closedP;
});

test('socket: a request that throws is answered with the error, and the connection keeps working', async () => {
  // a session whose visibility rule throws: the request fails, but the agent still gets an answer
  const real = new ToolSessions();
  let broken = true;
  const sessions: any = Object.assign(new EventEmitter(), {
    resolve: (t: string) => real.resolve(t),
    live: (d: string) => real.live(d),
    get: (k: string) => ({
      ...real.get(k),
      hide: () => {
        if (broken) throw new Error('rule broke');
        return false;
      },
    }),
  });
  const { file } = await server({ sessions });
  const { token } = real.open('k', { harnessPid: 1, chatId: 'chat' });
  const cl = client(file);
  cl.send({ id: 1, method: 'hello', params: { token, pid: 9 } });
  await cl.next();
  cl.send({ id: 2, method: 'tools/list' });
  assert.deepEqual(await cl.next(), { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'rule broke' } });
  broken = false;
  cl.send({ id: 3, method: 'tools/list' });
  assert.equal((await cl.next()).result.tools[0].name, 'echo');
  cl.c.destroy();
});

test('socket: a hello that throws (a bare null) is refused with the reason, not left waiting', async () => {
  const { file, rejected } = await server();
  const cl = client(file);
  cl.send('null\n');
  assert.deepEqual(await cl.next(), { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not allowed' } });
  assert.match(rejected.at(-1) ?? '', /null/);
  await cl.closedP;
});

test('socket: a hello whose token check throws is refused under its id', async () => {
  const sessions: any = Object.assign(new EventEmitter(), {
    resolve: () => {
      throw new Error('store broke');
    },
  });
  const { file, rejected } = await server({ sessions });
  const cl = client(file);
  cl.send({ id: 3, method: 'hello', params: { token: 't', pid: 9 } });
  assert.deepEqual(await cl.next(), { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'Not allowed' } });
  assert.equal(rejected.at(-1), 'store broke');
  await cl.closedP;
});

test('socket: hello without params or id is refused; a second message during the check closes it', async () => {
  let release: () => void = () => {};
  const { sessions, file, rejected } = await server({ verifyPeer: () => new Promise<null>((r) => (release = () => r(null))) });
  const a = client(file);
  a.send({ method: 'ping' });
  assert.deepEqual((await a.next()).error.code, -32001);
  assert.equal(rejected.at(-1), 'no hello');
  const b = client(file);
  b.send({ id: 1, method: 'hello' });
  assert.equal((await b.next()).id, 1);
  assert.equal(rejected.at(-1), 'unknown token');
  const { token } = sessions.open('k', { harnessPid: 1 });
  const c = client(file);
  c.send({ id: 1, method: 'hello', params: { token, pid: 9 } });
  await new Promise((r) => setTimeout(r, 20));
  c.send('{"id":2,"method":"tools/list"}\n{"id":3,"method":"tools/list"}\n');
  await c.closedP;
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rejected.at(-1), 'token revoked');
});

test('socket: a peer check that throws is the reason given; one that throws a non-error too', async () => {
  let n = 0;
  const { sessions, file, rejected } = await server({
    verifyPeer: async () => {
      if (n++ === 0) throw new Error('core missing');
      throw 'odd';
    },
  });
  const { token } = sessions.open('k', { harnessPid: 1 });
  for (const want of ['core missing', 'odd']) {
    const cl = client(file);
    cl.send({ id: 1, method: 'hello', params: { token, pid: 9 } });
    await cl.next();
    assert.equal(rejected.at(-1), want);
  }
});

test('socket: more than 4 MB without a newline closes the connection', async () => {
  const { file } = await server();
  const cl = client(file);
  cl.send('x'.repeat(4 * 1024 * 1024 + 10));
  await cl.closedP;
  assert.equal(cl.isClosed(), true);
});

test('socket: an error on an accepted connection is left to its close handler', async () => {
  const { s } = await server({ helloTimeoutMs: 60_000 });
  // a stand-in connection: the server hands it over as it does a real one
  const conn: any = Object.assign(new EventEmitter(), {
    destroyed: false,
    setEncoding() {},
    write() {},
    end() {},
    destroy() {},
  });
  s.server.emit('connection', conn);
  assert.equal(s.conns.size, 1);
  assert.doesNotThrow(() => conn.emit('error', new Error('ECONNRESET')));
  assert.equal(s.conns.size, 1, 'the error alone does not drop it');
  conn.emit('close');
  assert.equal(s.conns.size, 0);
});
