// The peer checks on real sockets and real processes through the real Rust core (crates/caps): who is accepted and who is refused, by what each kernel really answers. macOS names the last process to use a socket's far end; Linux the process that connected, while it holds that end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyPeer, peerHolds, startedBy, ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { verifyDescendant } = require('../electron/capabilities/browser/iabBackend/environment.cjs');
const { executableOf, startedByProcess } = require('../electron/capabilities/browser/chromeHostLinux.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const skip = process.platform === 'win32' ? 'unix sockets' : false;
const dir = fs.mkdtempSync('/tmp/caps-real-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A process that outlives this file and holds the pipes of its test process keeps the whole run waiting with every test
// green, past any test timeout, so: none inherits those pipes, each ends by itself (STAY), and each is killed here.
const children = new Set<ChildProcess>();
const handedTo = new Set<number>();
after(() => {
  children.forEach((c) => c.kill('SIGKILL'));
  for (const pid of handedTo) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // it has already ended
    }
  }
});
/** What keeps a script's process alive: longer than a test may run, and never for good. */
const STAY = 'setTimeout(() => process.exit(0), 60000);';

let n = 0;
/** A unix socket server: `next()` is the next connection it accepted. */
async function listen() {
  const file = path.join(dir, `${++n}.sock`);
  const waiting: ((s: net.Socket) => void)[] = [];
  const held: net.Socket[] = [];
  const server = net.createServer((s) => {
    s.on('error', () => undefined);
    const take = waiting.shift();
    if (take) take(s);
    else held.push(s);
  });
  await new Promise<void>((r) => server.listen(file, () => r()));
  after(() => server.close());
  return { file, next: () => new Promise<net.Socket>((r) => (held.length ? r(held.shift() as net.Socket) : waiting.push(r))) };
}

/** Node running `script`, with `file` as argv[1]; resolves once it prints a line, with that line. */
async function run(script: string, file: string) {
  const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(out.trim());
    });
    child.once('exit', () => reject(new Error(`exited before printing: ${out} ${err}`)));
  });
  return { child, line };
}

/** Connects, says one line, prints its pid and stays. */
const CONNECTS = `const s = require('net').connect(process.argv[1], () => s.write('hello\\n', () => console.log(process.pid)));
s.on('error', () => undefined); ${STAY}`;
/** Stays, connected to nothing. */
const IDLE = `console.log(process.pid); ${STAY}`;

/** Connects, hands the socket to a child of its own that says the hello line and stays; prints both pids and stays or exits. */
const hands = (stays: boolean, speaks: boolean) => `const { spawn } = require('child_process');
const net = require('net');
const s = net.connect(process.argv[1], () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(
    `${speaks ? `require('fs').writeSync(3, 'hello\\n');` : ''} console.log(process.pid); ${STAY}`,
  )}], { stdio: ['ignore', 'pipe', 'ignore', s._handle.fd] });
  child.stdout.once('data', (d) => {
    process.stdout.write(process.pid + ' ' + d);
    ${stays ? '' : 'setTimeout(() => process.exit(0), 50);'}
  });
});
${STAY}`;

/** Connects, says the hello line, hands the socket to a child that stays silent, closes its own copy, and stays. */
const LEFT = `const { spawn } = require('child_process');
const s = require('net').connect(process.argv[1], () => s.write('hello\\n', () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`console.log(process.pid); ${STAY}`)}], { stdio: ['ignore', 'pipe', 'ignore', s._handle.fd] });
  child.stdout.once('data', (d) => {
    s.destroy();
    setTimeout(() => process.stdout.write(process.pid + ' ' + d), 50);
  });
}));
s.on('error', () => undefined);
${STAY}`;

/** `hands`'s two pids; the second is no child of this file, so it is recorded for the end of the file. */
function handed(line: string) {
  const [connector, inheritor] = line.split(' ').map(Number);
  handedTo.add(inheritor);
  return [connector, inheritor];
}

test('a process the harness started, connected itself: accepted, on the socket and as a descendant', { skip }, async () => {
  const host = await listen();
  const { line } = await run(CONNECTS, host.file);
  const pid = Number(line);
  const socket = await host.next();
  assert.equal(await peerHolds({ socket, pid }), null);
  assert.equal(await verifyPeer({ socket, pid, harnessPid: process.pid }), null);
  assert.equal(await verifyDescendant({ socket, root: process.pid }), null);
  assert.equal(await startedBy(pid, process.pid), true);
  socket.destroy();
});

test('a process that only claims a real descendant’s pid is refused: this process connected, not the one it names', { skip }, async () => {
  const host = await listen();
  const { line } = await run(IDLE, host.file);
  const descendant = Number(line);
  const client = net.connect(host.file);
  await new Promise((r) => client.once('connect', r));
  client.write('hello\n');
  const socket = await host.next();
  await new Promise((r) => socket.once('data', r));
  assert.equal(await verifyPeer({ socket, pid: descendant, harnessPid: process.pid }), `process ${descendant} is not the one connected`);
  // and claiming itself, it is the peer, but nobody's child here: a harness that did not start it refuses it
  assert.equal(await peerHolds({ socket, pid: process.pid }), null);
  assert.equal(
    await verifyPeer({ socket, pid: process.pid, harnessPid: descendant }),
    `process ${process.pid} is not one the harness started`,
  );
  assert.equal(await verifyDescendant({ socket, root: descendant }), 'the peer is not under the harness');
  client.destroy();
  socket.destroy();
});

test('a process that was handed a connected socket: Linux names the one that connected, macOS the last to use it', { skip }, async () => {
  const host = await listen();
  const { line } = await run(hands(true, true), host.file);
  const [connector, inheritor] = handed(line);
  const socket = await host.next();
  await new Promise((r) => socket.once('data', r));
  const claim = await verifyPeer({ socket, pid: inheritor, harnessPid: process.pid });
  if (process.platform === 'linux') {
    assert.equal(claim, `process ${inheritor} is not the one connected`);
    assert.equal(await verifyPeer({ socket, pid: connector, harnessPid: process.pid }), null, 'the one that connected still holds it');
  } else {
    // it used the socket, so it is the peer; it holds the socket and the harness started it, which is what lsof showed
    assert.equal(claim, null);
    assert.equal(await verifyPeer({ socket, pid: connector, harnessPid: process.pid }), `process ${connector} is not the one connected`);
  }
  socket.destroy();
});

test('the process that connected has exited and another holds its socket: its number counts for no one', { skip }, async () => {
  const host = await listen();
  const { child, line } = await run(hands(false, false), host.file);
  const [connector, inheritor] = handed(line);
  const socket = await host.next();
  await new Promise((r) => child.once('exit', r));
  // a number a new process could have: gone from the table, and shown to hold nothing
  assert.equal(
    await verifyPeer({ socket, pid: connector, harnessPid: process.pid }),
    `process ${connector} is not one the harness started`,
  );
  assert.equal(await peerHolds({ socket, pid: connector }), 'socket not found');
  assert.equal(await verifyDescendant({ socket, root: process.pid }), 'socket not found');
  assert.match(
    String(await verifyPeer({ socket, pid: inheritor, harnessPid: process.pid })),
    /not the one connected|not one the harness started/,
  );
  socket.destroy();
});

test('the process that wrote the hello handed its socket on and lives: the claim of it fails, since it holds nothing now', {
  skip,
}, async () => {
  const host = await listen();
  const { line } = await run(LEFT, host.file);
  const [writer, holder] = line.split(' ').map(Number);
  handedTo.add(holder);
  const socket = await host.next();
  await new Promise((r) => socket.once('data', r));
  // every other check would pass: a live process the harness started, whose file is real
  assert.equal(await startedBy(writer, process.pid), true);
  assert.equal(await peerHolds({ socket, pid: writer }), 'socket not found');
  assert.equal(await verifyPeer({ socket, pid: writer, harnessPid: process.pid }), 'socket not found');
  assert.equal(await verifyDescendant({ socket, root: process.pid }), 'socket not found');
  // and the holder, which has not used it, is no peer on the kernel's word (macOS) nor the one that connected (Linux)
  assert.match(String(await peerHolds({ socket, pid: holder })), /not the one connected|socket not found/);
  socket.destroy();
});

test('a peer that has gone: its closed socket names no one', { skip }, async () => {
  const host = await listen();
  const { child, line } = await run(CONNECTS, host.file);
  const pid = Number(line);
  const socket = await host.next();
  socket.pause();
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(await peerHolds({ socket, pid }), 'socket not found');
  assert.equal(await verifyDescendant({ socket, root: process.pid }), 'socket not found');
  socket.destroy();
});

test('a socket that is no socket any more, and a descriptor that is no socket at all', { skip }, async () => {
  const file = fs.openSync(path.join(dir, 'plain'), 'w');
  after(() => fs.closeSync(file));
  assert.equal(await peerHolds({ socket: { _handle: { fd: file } }, pid: process.pid }), 'socket not found');
  assert.equal(await peerHolds({ socket: { _handle: { fd: 1 << 20 } }, pid: process.pid }), 'socket not found');
  assert.equal(await verifyDescendant({ socket: { _handle: { fd: 1 << 20 } }, root: process.pid }), 'socket not found');
});

test('the file a process runs and its parent, from the kernel: not what the process says of itself', { skip }, async () => {
  assert.equal(await executableOf(process.pid), fs.realpathSync(process.execPath));
  const { child, line } = await run(IDLE, dir);
  assert.equal(Number(line), child.pid);
  assert.equal(await startedByProcess(child.pid), process.pid);
  assert.equal(await executableOf(child.pid), fs.realpathSync(process.execPath));
  const renamed = spawn(process.execPath, ['-e', STAY], { argv0: '/opt/google/chrome/chrome', stdio: 'ignore' });
  children.add(renamed);
  assert.equal(await executableOf(renamed.pid), fs.realpathSync(process.execPath), 'argv[0] is its own word');
  assert.equal(await executableOf(1 << 22), null, 'no such process');
  assert.equal(await startedByProcess(1 << 22), null);
});

test('the whole hello: a process the harness started gets its session, another pid on the same token does not', { skip }, async () => {
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: new Registry() });
  after(() => socket.close());
  const file = await socket.listen();
  const { token } = sessions.open('k', { harnessPid: process.pid });
  /** Says hello as `pid` from a real child, and prints the reply. */
  const SAYS = (
    pid: string,
  ) => `const s = require('net').connect(process.argv[1], () => s.write(JSON.stringify({ jsonrpc: '2.0', id: 'hello', method: 'hello', params: { token: ${JSON.stringify(token)}, pid: ${pid} } }) + '\\n'));
s.setEncoding('utf8'); s.on('error', () => undefined); s.on('data', (d) => { console.log(d.trim()); }); ${STAY}`;
  assert.ok(JSON.parse((await run(SAYS('process.pid'), file)).line).result);
  // a child naming its parent, which is the harness and not the process connected
  assert.equal(JSON.parse((await run(SAYS('process.ppid'), file)).line).error.message, 'Not allowed');
  // a child naming a sibling the harness did start
  const sibling = Number((await run(IDLE, dir)).line);
  assert.equal(JSON.parse((await run(SAYS(String(sibling)), file)).line).error.message, 'Not allowed');
});
