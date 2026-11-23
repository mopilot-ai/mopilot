// native/sage-mcp and electron/capabilities/mcp/socket.cjs: a real sage-mcp, launched the way a harness
// launches an MCP server, round-trips tools/list and tools/call to main's socket; a wrong token, a
// process that isn't the harness's child, and a process impersonating sage-mcp are all turned away.
import { waitFor } from './support/waitFor.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import { ensureSageMcp } from '../scripts/build-sage-mcp.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket, sageMcpPath, callToolResult } = require('../electron/capabilities/mcp/socket.cjs');
const { parseLsof } = require('../electron/capabilities/httpMcp.cjs');
const debugTools = require('../electron/capabilities/tools/debug.cjs');

test('sage-mcp path: Contents/Helpers when packaged, native/sage-mcp/build in a checkout; the Rust one in a Linux package', () => {
  const resourcesPath = '/A.app/Contents/Resources';
  assert.equal(sageMcpPath({ packaged: true, resourcesPath, platform: 'darwin' }), '/A.app/Contents/Helpers/sage-mcp');
  assert.equal(sageMcpPath({ repoRoot: '/repo', platform: 'darwin' }), '/repo/native/sage-mcp/build/sage-mcp');
  assert.equal(
    sageMcpPath({ packaged: true, resourcesPath: '/opt/MoPilot/resources', platform: 'linux' }),
    '/opt/MoPilot/resources/core/sage-mcp',
  );
  // a Linux checkout's Swift build is what its Chrome E2E's native host runs (chromeRelay.cjs)
  assert.equal(sageMcpPath({ repoRoot: '/repo', platform: 'linux' }), '/repo/native/sage-mcp/build/sage-mcp');
});

test('lsof -F output is read per process and file', () => {
  const files = parseLsof('p10\nf14\nd0xaa\nn/tmp/s.sock\np20\nf3\nd0xbb\nn->0xaa\n');
  assert.deepEqual(files, [
    { pid: 10, fd: '14', device: '0xaa', name: '/tmp/s.sock' },
    { pid: 20, fd: '3', device: '0xbb', name: '->0xaa' },
  ]);
});

test('a failed call comes back as an MCP error result with its message', () => {
  assert.deepEqual(callToolResult({ ok: false, content: [], error: { code: 'denied', message: 'no' } }), {
    content: [{ type: 'text', text: 'no' }],
    isError: true,
  });
  assert.deepEqual(callToolResult({ ok: true, content: [{ type: 'text', text: 'hi' }] }), {
    content: [{ type: 'text', text: 'hi' }],
    isError: false,
  });
});

// built once per run, under a lock shared with the other test files (a failed build fails here, loudly)
const builtBin = ensureSageMcp({ log: console.error });
const skip = builtBin ? false : 'needs macOS with a swift toolchain to build sage-mcp';

let bin = '';
let sessions: any;
let registry: any;
let sock: any;
let socketPath = '';
const rejected: string[] = [];
const connected: any[] = [];

before(async () => {
  if (skip) return;
  bin = builtBin!;
  sessions = new ToolSessions();
  registry = new Registry();
  registry.register(debugTools.echo);
  sock = new ToolSocket({ sessions, registry, helloTimeoutMs: 2000 });
  sock.on('rejected', (e: any) => rejected.push(e.reason));
  sock.on('connected', (e: any) => connected.push(e));
  socketPath = await sock.listen();
});
after(() => sock?.close());

/** Launches sage-mcp as this process's child, as a harness would, and talks MCP to it. */
function launch(token: string) {
  const child = spawn(bin, [], {
    env: { PATH: process.env.PATH, SAGE_MCP_SOCKET: socketPath, SAGE_MCP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (m: any) => void>();
  let stderr = '';
  let buf = '';
  let next = 1;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(m.id)?.(m);
    }
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  return {
    child,
    exited,
    stderr: () => stderr,
    request: (method: string, params: any = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 15s; stderr: ${stderr}`)), 15_000);
        // a sage-mcp that died (killed on launch, refused) answers nothing: say so now, not at the test timeout
        exited.then((code) => reject(new Error(`sage-mcp exited (${code}) before answering ${method}; stderr: ${stderr}`)));
        pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    close: () => (child.stdin.end(), exited),
  };
}

test('tools/list and tools/call round-trip through sage-mcp to main', { skip, timeout: 30_000 }, async () => {
  const { serverName, token } = sessions.open('chat-1', { harnessPid: process.pid });
  const mcp = launch(token);
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.serverInfo.name, serverName);
  assert.ok(init.result.capabilities.tools);
  mcp.notify('notifications/initialized');
  assert.deepEqual((await mcp.request('ping')).result, {});
  const listed = await mcp.request('tools/list');
  const echo = listed.result.tools.find((t: any) => t.name === 'sage_debug_echo');
  assert.ok(echo, 'sage_debug_echo is listed');
  assert.equal(echo.annotations.readOnlyHint, true);
  assert.deepEqual(echo.inputSchema.required, ['text']);
  const called = await mcp.request('tools/call', { name: 'sage_debug_echo', arguments: { text: 'marmalade' } });
  assert.deepEqual(called.result, { content: [{ type: 'text', text: 'echo: marmalade' }], isError: false });
  const bad = await mcp.request('tools/call', { name: 'sage_debug_echo', arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.equal((await mcp.request('resources/list')).error.code, -32601);
  assert.equal(connected.at(-1).key, 'chat-1');
  assert.equal(await mcp.close(), 0);
  sessions.end('chat-1');
});

test('a wrong token is refused and sage-mcp exits', { skip, timeout: 30_000 }, async () => {
  sessions.open('chat-2', { harnessPid: process.pid });
  const mcp = launch('not-the-token');
  assert.equal(await mcp.exited, 1);
  assert.match(mcp.stderr(), /refused/);
  assert.equal(rejected.at(-1), 'unknown token');
  sessions.end('chat-2');
});

test('a sage-mcp the harness started further down is accepted (an ACP adapter runs the CLI that starts it, #1320); a process it did not start is refused', {
  skip,
  timeout: 30_000,
}, async () => {
  // the session says its harness is our parent: sage-mcp here is our child, so its grandchild
  const below = sessions.open('chat-3', { harnessPid: process.ppid });
  const mcp = launch(below.token);
  await mcp.request('initialize', {});
  assert.equal((await mcp.request('tools/call', { name: 'sage_debug_echo', arguments: { text: 'x' } })).result.isError, false);
  await mcp.close();
  sessions.end('chat-3');
  // a harness that is some other process (a sibling of ours): sage-mcp is not one it started
  const other = spawn('/bin/sleep', ['30']);
  const { token } = sessions.open('chat-3b', { harnessPid: other.pid });
  const refused = launch(token);
  assert.equal(await refused.exited, 1);
  assert.match(rejected.at(-1)!, /not one the harness started/);
  other.kill();
  sessions.end('chat-3b');
});

/** Connects straight to main's socket and sends a hello; resolves with main's reply (or null on close). */
function directHello(params: any) {
  return new Promise<any>((resolve) => {
    const s = net.createConnection(socketPath);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
        s.destroy();
      }
    });
    s.on('close', () => resolve(null));
    s.on('connect', () => s.write(JSON.stringify({ jsonrpc: '2.0', id: 'hello', method: 'hello', params }) + '\n'));
  });
}

test('a direct connection that borrows a real sage-mcp pid and token is refused', { skip, timeout: 30_000 }, async () => {
  const { token } = sessions.open('chat-4', { harnessPid: process.pid });
  const mcp = launch(token);
  await mcp.request('initialize', {});
  // knows the token and names the real sage-mcp (a genuine child of the harness), but isn't it
  const reply = await directHello({ token, pid: mcp.child.pid, ppid: process.pid });
  assert.equal(reply.error.code, -32001);
  assert.match(rejected.at(-1)!, /is not the one connected/);
  // claiming the harness's own pid fails the ancestry check instead
  await directHello({ token, pid: process.pid, ppid: process.ppid });
  assert.match(rejected.at(-1)!, /not one the harness started/);
  // the real one still works
  assert.equal((await mcp.request('tools/call', { name: 'sage_debug_echo', arguments: { text: 'x' } })).result.isError, false);
  await mcp.close();
  sessions.end('chat-4');
});

test('rotating the token on resume cuts the old connection and refuses the old token', { skip, timeout: 30_000 }, async () => {
  const first = sessions.open('chat-5', { harnessPid: process.pid });
  const mcp = launch(first.token);
  await mcp.request('initialize', {});
  await mcp.request('tools/list');
  const second = sessions.rotate('chat-5');
  assert.equal(second.serverName, first.serverName);
  assert.notEqual(second.token, first.token);
  // main closes the socket, so sage-mcp has nothing left to serve
  assert.equal(await mcp.exited, 0);
  const again = launch(first.token);
  assert.equal(await again.exited, 1);
  assert.equal(rejected.at(-1), 'unknown token');
  const fresh = launch(second.token);
  assert.equal(
    (await fresh.request('tools/call', { name: 'sage_debug_echo', arguments: { text: 'y' } })).result.content[0].text,
    'echo: y',
  );
  // the session ends: its token is gone too
  sessions.end('chat-5');
  assert.equal(await fresh.exited, 0);
  const stale = launch(second.token);
  assert.equal(await stale.exited, 1);
});

test('a harness cancelling one call (notifications/cancelled) reaches main through sage-mcp and stops that call', {
  skip,
  timeout: 30_000,
}, async () => {
  const started: string[] = [];
  const off = registry.register({
    name: 'sage_test_wait',
    policy: 'observe',
    handler: (args: any, ctx: any) =>
      new Promise((resolve) => {
        started.push(args.n);
        ctx.signal.addEventListener('abort', () => resolve('aborted'));
      }),
  });
  const { token } = sessions.open('chat-6', { harnessPid: process.pid });
  const mcp = launch(token);
  await mcp.request('initialize', {});
  const call = mcp.request('tools/call', { name: 'sage_test_wait', arguments: { n: 'one' } });
  await waitFor(() => started.length > 0, 'the call to start');
  // the first request was initialize (id 1): this call is id 2
  mcp.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n');
  const res = await call;
  assert.equal(res.result.isError, true);
  assert.match(res.result.content.at(-1).text, /harness cancelled this call/);
  off();
  await mcp.close();
  sessions.end('chat-6');
});

test('a connection that never says hello is closed', { skip, timeout: 30_000 }, async () => {
  const closed = await new Promise<boolean>((resolve) => {
    const s = net.createConnection(socketPath);
    s.on('data', () => {});
    s.on('close', () => resolve(true));
  });
  assert.equal(closed, true);
  assert.equal(rejected.at(-1), 'no hello');
});

// A harness exiting or main going away must end sage-mcp quietly. It once aborted (SIGABRT, a crash
// report and an "unexpectedly quit" dialog) because FileHandle.write raises on a closed pipe.
const reportDir = `${process.env.HOME}/Library/Logs/DiagnosticReports`;
const crashReports = () => (fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter((f) => f.startsWith('sage-mcp-')) : []);

/** A stand-in for main's socket that answers hello and then echoes nothing; the test controls when it goes away. */
function fakeMain() {
  const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/smcp-`);
  const file = `${dir}/s.sock`;
  const conns: net.Socket[] = [];
  const server = net.createServer((c) => {
    conns.push(c);
    c.setEncoding('utf8');
    c.once('data', () => c.write(JSON.stringify({ jsonrpc: '2.0', id: 'hello', result: { serverName: 'sage' } }) + '\n'));
    c.on('error', () => {});
  });
  return {
    file,
    listen: () => new Promise<void>((r) => server.listen(file, r)),
    dropConnections: () => conns.forEach((c) => c.destroy()),
    close: () => (server.close(), fs.rmSync(dir, { recursive: true, force: true })),
  };
}

function spawnAgainst(file: string) {
  const child = spawn(bin, [], {
    env: { PATH: process.env.PATH, SAGE_MCP_SOCKET: file, SAGE_MCP_TOKEN: 't' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
    child.once('exit', (code, signal) => r({ code, signal })),
  );
  child.stdin.on('error', () => {});
  return { child, exited };
}

test('sage-mcp exits cleanly, with no crash report, when the harness closes its pipes mid-conversation', {
  skip,
  timeout: 30_000,
}, async () => {
  const before = new Set(crashReports());
  const main = fakeMain();
  await main.listen();
  try {
    const run = spawnAgainst(main.file);
    run.child.stdout.setEncoding('utf8');
    const first = new Promise<void>((r) => run.child.stdout.once('data', () => r()));
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await first;
    // the harness is gone: nobody reads stdout or stderr any more, and it keeps no stdin open
    run.child.stdout.destroy();
    run.child.stderr.destroy();
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    run.child.stdin.end();
    const { code, signal } = await run.exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally {
    main.close();
  }
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(
    crashReports().filter((f) => !before.has(f)),
    [],
  );
});

test('sage-mcp exits cleanly, with no crash report, when the socket to main goes away', { skip, timeout: 30_000 }, async () => {
  const before = new Set(crashReports());
  const main = fakeMain();
  await main.listen();
  try {
    // main drops the connection mid-conversation, while the harness side stays open
    const run = spawnAgainst(main.file);
    run.child.stdout.setEncoding('utf8');
    const first = new Promise<void>((r) => run.child.stdout.once('data', () => r()));
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await first;
    main.dropConnections();
    const dropped = await run.exited;
    assert.equal(dropped.signal, null);
    assert.equal(dropped.code, 0);

    // main is gone before sage-mcp even connects, and nobody reads its stderr: a real error, still not a crash
    main.close();
    const late = spawnAgainst(main.file);
    late.child.stderr.destroy();
    const failed = await late.exited;
    assert.equal(failed.signal, null);
    assert.equal(failed.code, 1);
  } finally {
    main.close();
  }
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(
    crashReports().filter((f) => !before.has(f)),
    [],
  );
});
