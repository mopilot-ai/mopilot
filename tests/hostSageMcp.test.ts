// The Host's sage-mcp: what `status` says of the peer check, and the portable stdio shim (host/src/sageMcpShim.mjs, host/bin/sage-mcp.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { runShim } from '../host/src/sageMcpShim.mjs';
import { coreStatus, hostStatus } from '../host/src/status.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-sagemcp-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
// unix socket paths must stay short, so these sockets live in a short folder of their own
const short = fs.mkdtempSync('/tmp/hsm-');
after(() => fs.rmSync(short, { recursive: true, force: true }));

test('Host status says which isolation guarantees the peer check gives on this machine', () => {
  const served = hostStatus({ running: true, peerCheck: true });
  const none = hostStatus({ running: true, peerCheck: false });
  assert.ok(!none.isolation.delivered.some((l: string) => /peer check/.test(l)));
  assert.ok(none.isolation.blocked.some((l: string) => /the Rust core cannot run it here/.test(l)));
  assert.equal(typeof hostStatus({ running: true }).isolation.delivered.length, 'number');
  // the Rust core: reported, with why a Host has none
  const reported = hostStatus({ running: true }).core;
  assert.deepEqual([reported.loaded, reported.build, reported.problem], [true, null, null]);
  assert.ok(reported.routes > 0);
  assert.deepEqual(coreStatus({ routes: () => ['a', 'b'] }, { build: 'linux-x64-gnu' }, null), {
    loaded: true,
    build: 'linux-x64-gnu',
    routes: 2,
    problem: null,
  });
  assert.deepEqual(coreStatus(null, { build: 'linux-x64-gnu' }, 'The Rust core is missing.'), {
    loaded: false,
    build: 'linux-x64-gnu',
    routes: 0,
    problem: 'The Rust core is missing.',
  });
  assert.ok(
    served.isolation.delivered.some(
      (l: string) => /MoPilot tools for ACP, Claude Code and Codex chats.*sage-mcp peer check/.test(l) && /Rust core/.test(l),
    ),
  );
  assert.ok(!served.isolation.blocked.some((l: string) => /tool socket|peer check|SO_PEERCRED/.test(l)), 'every family gets tools now');
  // the machine's answer by default: the same on every platform, with no tool to install
  for (const platform of ['linux', 'darwin'] as const)
    assert.deepEqual(hostStatus({ running: true, platform }).isolation.delivered, hostStatus({ running: true }).isolation.delivered);
  assert.ok(!JSON.stringify(hostStatus({ running: true }).isolation).match(/\bss\b|lsof/));
});

/* -- the shim ---------------------------------------------------------- */

async function withHost(handler: (line: string, write: (s: string) => void, c: net.Socket) => void) {
  const file = path.join(short, `h-${Math.random().toString(36).slice(2, 6)}.sock`);
  const lines: string[] = [];
  const server = net.createServer((c) => {
    c.setEncoding('utf8');
    // a shim the test kills resets its connection (ECONNRESET on Linux): the Host's own server destroys such a socket
    c.on('error', () => c.destroy());
    let buf = '';
    c.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        handler(line, (s) => c.write(s), c);
      }
    });
  });
  await new Promise((r) => server.listen(file, () => r(undefined)));
  return { file, lines, close: () => server.close() };
}
const harness = () => {
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const stdout = { write: (s: string) => out.push(s) };
  const stderr = { write: (s: string) => err.push(s) };
  return {
    stdin,
    out,
    err,
    stdout,
    stderr,
    send: (o: object | string) => stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`),
  };
};
const until = async (fn: () => any, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const hello = (line: string, write: (s: string) => void) => {
  const m = JSON.parse(line);
  if (m.method === 'hello') write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: { serverName: 'sage_test' } })}\n`);
  else write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echoed: m.method } })}\n`);
};

test('the shim says hello, answers initialize and ping itself, and forwards tools/list and tools/call', async () => {
  const host = await withHost(hello);
  const h = harness();
  const done = runShim({
    env: { SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 'tok' },
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    pid: 4242,
    ppid: 77,
  });
  await until(() => host.lines.length);
  assert.deepEqual(JSON.parse(host.lines[0]).params, { token: 'tok', pid: 4242, ppid: 77, version: '1.0.0' });
  // sent before the Host answered hello: held until it did
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  h.send({ jsonrpc: '2.0', id: 2, method: 'initialize' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x' } });
  h.send({ jsonrpc: '2.0', id: 6, method: 'nope' });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: null, method: 'ping' });
  h.send({ jsonrpc: '2.0', id: 7, result: {} });
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  h.send('');
  h.send('{not json');
  await until(() => h.out.length >= 7);
  const replies = h.out.map((l) => JSON.parse(l));
  const byId = (id: number) => replies.find((r) => r.id === id);
  assert.deepEqual(byId(1).result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'sage_test', version: '1.0.0' },
  });
  assert.equal(byId(2).result.protocolVersion, '2025-06-18');
  assert.deepEqual(byId(3).result, {});
  assert.deepEqual(byId(4).result, { echoed: 'tools/list' });
  assert.deepEqual(byId(5).result, { echoed: 'tools/call' });
  assert.equal(byId(6).error.code, -32601);
  assert.equal(replies.find((r) => r.id === null).error.code, -32700);
  await until(() => host.lines.some((l) => l.includes('notifications/cancelled')));
  assert.equal(host.lines.filter((l) => l.includes('notifications/initialized')).length, 0, 'other notifications stay here');
  h.stdin.end();
  assert.equal(await done, 0);
  host.close();
});

test('the shim exits 0 when the Host hangs up and says why it fails when it cannot start', async () => {
  const host = await withHost(hello);
  const h = harness();
  const done = runShim({ env: { SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 't' }, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr });
  h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await until(() => h.out.length);
  host.close();
  // the Host closing the connection ends it
  const fresh = await withHost((line, write, c) => (hello(line, write), c.end()));
  const h2 = harness();
  assert.equal(
    await runShim({ env: { SAGE_MCP_SOCKET: fresh.file, SAGE_MCP_TOKEN: 't' }, stdin: h2.stdin, stdout: h2.stdout, stderr: h2.stderr }),
    0,
  );
  fresh.close();
  h.stdin.end();
  await done;
  // a call after the Host went away gets an error, not silence
  const dying = await withHost((line, write) => hello(line, write));
  const h3 = harness();
  const gone = runShim({
    env: { SAGE_MCP_SOCKET: dying.file, SAGE_MCP_TOKEN: 't' },
    stdin: h3.stdin,
    stdout: h3.stdout,
    stderr: h3.stderr,
    connect: ((p: string) => {
      const s = net.connect(p);
      s.once('connect', () => setTimeout(() => (s.end(), ((s as any).writable = false)), 30));
      return s;
    }) as any,
  });
  await new Promise((r) => setTimeout(r, 15));
  h3.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  await gone;
  dying.close();

  const run = async (env: object, frames?: (c: net.Socket) => void) => {
    const x = harness();
    const code = await runShim({ env: env as any, stdin: x.stdin, stdout: x.stdout, stderr: x.stderr });
    return { code, err: x.err.join('') };
  };
  assert.match((await run({ SAGE_MCP_TOKEN: 't' })).err, /SAGE_MCP_SOCKET is not set/);
  assert.match((await run({ SAGE_MCP_SOCKET: '/x' })).err, /SAGE_MCP_TOKEN is not set/);
  // each failure is said once: the close that follows an error or a refusal adds no second, wrong reason
  const missing = await run({ SAGE_MCP_SOCKET: path.join(short, 'nope.sock'), SAGE_MCP_TOKEN: 't' });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^sage-mcp: can't reach the Host: [^\n]*\n$/);
  const refusing = await withHost((_l, write) =>
    write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', error: { message: 'bad token' } })}\n`),
  );
  const refused = await run({ SAGE_MCP_SOCKET: refusing.file, SAGE_MCP_TOKEN: 't' });
  assert.deepEqual([refused.code, refused.err], [1, 'sage-mcp: the Host refused the connection: bad token\n']);
  refusing.close();
  const garbled = await withHost((_l, write) => write('<html>\n'));
  assert.equal((await run({ SAGE_MCP_SOCKET: garbled.file, SAGE_MCP_TOKEN: 't' })).err, 'sage-mcp: the Host refused the connection\n');
  garbled.close();
  const silent = await withHost((_l, _w, c) => c.end());
  const closed = await run({ SAGE_MCP_SOCKET: silent.file, SAGE_MCP_TOKEN: 't' });
  assert.deepEqual([closed.code, closed.err], [1, 'sage-mcp: the Host refused the connection\n']);
  silent.close();
  // stdin ending before the Host answered hello: what the harness sent is served once it does, then the shim ends, as
  // the Rust bridge does; a Host that never answers is a refusal, said once
  let accept: () => void = () => undefined;
  const slow = await withHost((line, write) => {
    if (JSON.parse(line).method === 'hello')
      accept = () => write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: { serverName: 'late' } })}\n`);
  });
  const h4 = harness();
  const early = runShim({
    env: { SAGE_MCP_SOCKET: slow.file, SAGE_MCP_TOKEN: 't' },
    stdin: h4.stdin,
    stdout: h4.stdout,
    stderr: h4.stderr,
  });
  await until(() => slow.lines.length);
  h4.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  h4.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h4.stdin.end();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h4.out, [], 'nothing is answered before hello is');
  accept();
  assert.equal(await early, 0);
  assert.equal(JSON.parse(h4.out[0]).result.serverInfo.name, 'late');
  await until(() => slow.lines.length === 2);
  assert.equal(JSON.parse(slow.lines[1]).method, 'tools/list');
  assert.deepEqual(h4.err, []);
  slow.close();
  let held: net.Socket | null = null;
  const mute = await withHost((_l, _w, c) => void (held = c));
  const h5 = harness();
  const unanswered = runShim({
    env: { SAGE_MCP_SOCKET: mute.file, SAGE_MCP_TOKEN: 't' },
    stdin: h5.stdin,
    stdout: h5.stdout,
    stderr: h5.stderr,
  });
  await until(() => mute.lines.length);
  h5.stdin.end();
  await new Promise((r) => setTimeout(r, 30));
  held!.end();
  mute.close();
  assert.equal(await unanswered, 1);
  assert.deepEqual(h5.err, ['sage-mcp: the Host refused the connection\n']);
});

test('a line from either side past what the shim reads ends it, saying so; a CRLF line is read without its CR', async () => {
  const host = await withHost(hello);
  const h = harness();
  const done = runShim({
    env: { SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 't' },
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    lineUnits: 80,
  });
  h.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\r\n`);
  await until(() => h.out.length);
  assert.deepEqual(JSON.parse(h.out[0]), { jsonrpc: '2.0', id: 1, result: {} });
  h.stdin.write(`${'x'.repeat(81)}\n`);
  assert.equal(await done, 1);
  assert.match(h.err.join(''), /a message is longer than a line can be/);
  host.close();
});

test('without a core to frame its streams the shim says so before it connects, and lets go of a framer it opened', async () => {
  const env = { SAGE_MCP_SOCKET: '/nowhere.sock', SAGE_MCP_TOKEN: 't' };
  const connect = (() => assert.fail('nothing connects without a reader')) as any;
  const h = harness();
  assert.equal(await runShim({ env, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, connect, addon: null }), 1);
  // the error every core call throws without a core, said before anything connects
  assert.deepEqual(h.err, ['sage-mcp: The Rust core is missing.\n']);
  // the second stream's framer fails to open: the first, opened, is closed
  const calls: string[] = [];
  const addon = {
    routes: () => [],
    dispatch: async () => Buffer.alloc(0),
    dispatchSync: (route: string) => {
      calls.push(route);
      if (route === 'framing.open' && calls.length > 1) throw new Error('no more framers');
      return Buffer.from('7');
    },
    dispatchCancellable: () => assert.fail('the shim makes no cancellable call'),
    cancel: () => assert.fail('the shim cancels nothing'),
    subscribe: () => assert.fail('the shim hears no events'),
  };
  const h2 = harness();
  assert.equal(await runShim({ env, stdin: h2.stdin, stdout: h2.stdout, stderr: h2.stderr, connect, addon }), 1);
  assert.deepEqual([calls, h2.err], [['framing.open', 'framing.open', 'framing.close'], ['sage-mcp: no more framers\n']]);
});

test('the shim tolerates blank lines and a hello reply without a name, and answers calls the Host can no longer take', async () => {
  const host = await withHost((line, write) => {
    write('\n');
    write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: {} })}\n`);
  });
  const h = harness();
  const done = runShim({ env: { SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 't' }, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr });
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await until(() => h.out.length);
  assert.equal(JSON.parse(h.out[0]).result.serverInfo.name, 'sage');
  h.stdin.end();
  await done;
  host.close();
  const bare = await withHost((_l, write) => write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', error: {} })}\n`));
  const x = harness();
  assert.equal(
    await runShim({ env: { SAGE_MCP_SOCKET: bare.file, SAGE_MCP_TOKEN: 't' }, stdin: x.stdin, stdout: x.stdout, stderr: x.stderr }),
    1,
  );
  bare.close();

  // a socket that stopped being writable after hello: the call is answered with an error
  const wrote: string[] = [];
  const fake: any = new Duplex({
    read() {},
    write(chunk, _e, cb) {
      wrote.push(String(chunk));
      cb();
    },
  });
  const y = harness();
  const gone = runShim({
    env: { SAGE_MCP_SOCKET: 'x', SAGE_MCP_TOKEN: 't' },
    stdin: y.stdin,
    stdout: y.stdout,
    stderr: y.stderr,
    connect: (() => fake) as any,
  });
  fake.emit('connect');
  fake.push(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: { serverName: 's' } })}\n`);
  await until(() => wrote.length);
  await new Promise((r) => setTimeout(r, 20));
  Object.defineProperty(fake, 'writable', { value: false });
  y.send({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
  await until(() => y.out.length);
  assert.equal(JSON.parse(y.out[0]).error.code, -32603);
  y.stdin.end();
  assert.equal(await gone, 0);
});

test('bin/sage-mcp.mjs exits quietly when the harness has gone away', async () => {
  const host = await withHost(hello);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'host/bin/sage-mcp.mjs')], {
    env: { ...process.env, SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 't' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  // the test tears these pipes down itself: their resets and broken writes are expected
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('error', () => undefined);
  await until(() => host.lines.length);
  child.stdout.destroy();
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 20; i++) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' })}\n`);
  assert.equal(await exited, 0);
  host.close();
});

test('bin/sage-mcp.mjs runs as a harness would start it', async () => {
  const host = await withHost(hello);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'host/bin/sage-mcp.mjs')], {
    env: { ...process.env, SAGE_MCP_SOCKET: host.file, SAGE_MCP_TOKEN: 't' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await until(() => out.includes('tools/list'));
  const exited = new Promise((r) => child.on('exit', r));
  child.stdin.end();
  assert.equal(await exited, 0);
  host.close();
});
