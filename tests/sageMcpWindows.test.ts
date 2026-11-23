// sage-mcp on Windows: the tool socket on 127.0.0.1 (platform/loopbackListener.cjs), its peer named by netstat's TCP table
// (capabilities/mcp/peerWindows.cjs) for the socket and the http channel, the Rust sage-mcp's path, and the portable
// sage-mcp reaching a loopback address. Scripted netstat everywhere; the real one on a Windows machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runShim } from '../host/src/sageMcpShim.mjs';

import { fakeCore, READY_ROUTES } from './support/fake-core.ts';
const require = createRequire(import.meta.url);
const { netstatPath, parseNetstat, tcpOwnerWindows, peerHoldsWindows } = require('../electron/capabilities/mcp/peerWindows.cjs');
const { LoopbackListener } = require('../electron/platform/loopbackListener.cjs');
const { ToolSocket, verifyPeer, sageMcpPath } = require('../electron/capabilities/mcp/socket.cjs');
const { sageMcpReady, peerCheckReady } = require('../electron/capabilities/mcp/sageMcpReady.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
const { sageMcpEnv } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { tcpPeerPid, verifyTcpPeer, PEER_NOT_FOUND } = require('../electron/capabilities/httpMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    127.0.0.1:50001        127.0.0.1:50000        HERGESTELLT     4242
  TCP    127.0.0.1:50000        127.0.0.1:50001        HERGESTELLT     99\r
  TCP    127.0.0.1:50003        127.0.0.1:50000        ESTABLISHED     pid
  UDP    127.0.0.1:50005        *:*                                    7
`;

/** An execFile stand-in that answers each of `outs` in turn, and records what ran. */
function netstat(...outs: (string | null)[]) {
  const calls: any[] = [];
  const fn = (cmd: string, args: string[], o: any, cb: (e: any, out: any) => void) => {
    calls.push([cmd, args, o]);
    const out = outs.length ? outs.shift() : '';
    cb(out === null ? new Error('netstat failed') : null, out);
  };
  return { fn, calls };
}
// main accepted it on 50000; sage-mcp's end is 50001
const accepted = { localPort: 50000, remotePort: 50001 };

test('netstat is System32 by its full path, wherever SystemRoot names, and C:\\Windows when nothing does', () => {
  assert.equal(netstatPath({ SYSTEMROOT: 'D:\\Win' }), 'D:\\Win\\System32\\netstat.exe');
  assert.equal(netstatPath({}), 'C:\\Windows\\System32\\netstat.exe');
});

test('netstat rows give each TCP connection its owner, whatever the language of its state; other rows are left out', () => {
  const owners = parseNetstat(NETSTAT);
  assert.equal(owners.get('127.0.0.1:50001 127.0.0.1:50000'), 4242);
  assert.equal(owners.get('127.0.0.1:50000 127.0.0.1:50001'), 99);
  assert.equal(owners.get('0.0.0.0:135 0.0.0.0:0'), 1012);
  assert.equal(owners.size, 3, 'no header, UDP or unnumbered row');
});

test('the owner of the far end is the row whose local address is the connection remote one; netstat printing nothing is asked once more', async () => {
  const once = netstat(NETSTAT);
  assert.equal(await tcpOwnerWindows(accepted, once.fn, { SystemRoot: 'C:\\W' }), 4242);
  assert.deepEqual(once.calls, [
    ['C:\\W\\System32\\netstat.exe', ['-ano', '-p', 'TCP'], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }],
  ]);
  const twice = netstat('', NETSTAT);
  assert.equal(await tcpOwnerWindows(accepted, twice.fn, {}), 4242);
  assert.equal(twice.calls.length, 2);
  // a table cut short (a time limit, a full buffer) without the row is asked once more too
  const cut = netstat(NETSTAT.slice(0, NETSTAT.indexOf('127.0.0.1:50001')), NETSTAT);
  assert.equal(await tcpOwnerWindows(accepted, cut.fn, {}), 4242);
  assert.equal(cut.calls.length, 2);
  // gone, failed, or no connection to ask about
  assert.equal(await tcpOwnerWindows({ localPort: 50000, remotePort: 50009 }, netstat(NETSTAT).fn, {}), null);
  assert.equal(await tcpOwnerWindows(accepted, netstat(null, null).fn, {}), null);
  const none = netstat();
  assert.equal(await tcpOwnerWindows({ localPort: 50000 }, none.fn, {}), null);
  assert.equal(none.calls.length, 0);
});

test('a peer holds the socket only when netstat says the connection is its own', async () => {
  assert.equal(await peerHoldsWindows({ socket: accepted, pid: 4242, execFile: netstat(NETSTAT).fn, env: {} }), null);
  assert.equal(
    await peerHoldsWindows({ socket: accepted, pid: 77, execFile: netstat(NETSTAT).fn, env: {} }),
    'process 77 is not the one connected',
  );
  assert.equal(await peerHoldsWindows({ socket: accepted, pid: 4242, execFile: netstat('', '').fn, env: {} }), 'socket not found');
});

/** A core stand-in that answers caps.ancestry with `chain`. */
const core = (chain: number[]) => ({
  dispatch: async (route: string) => Buffer.from(JSON.stringify(route === 'caps.ancestry' ? chain : null)),
});

test('verifyPeer on Windows: the ancestry is the core table alone (no ps), then netstat names the connected process', async () => {
  const peer = { ...accepted };
  // sage-mcp 4242 <- the CLI 40 <- the ACP adapter 5
  const ok = netstat(NETSTAT);
  assert.equal(
    await verifyPeer({ socket: peer, pid: 4242, harnessPid: 5, platform: 'win32', execFile: ok.fn, addon: core([4242, 40, 5]) }),
    null,
  );
  assert.equal(ok.calls.length, 1, 'only netstat ran');
  assert.equal(
    await verifyPeer({ socket: peer, pid: 77, harnessPid: 5, platform: 'win32', execFile: netstat(NETSTAT).fn, addon: core([77, 5]) }),
    'process 77 is not the one connected',
  );
  // no core: nothing on Windows reads a parent, so nobody passes
  const bare = netstat(NETSTAT);
  assert.equal(
    await verifyPeer({ socket: peer, pid: 4242, harnessPid: 5, platform: 'win32', execFile: bare.fn, addon: null }),
    'process 4242 is not one the harness started',
  );
  assert.equal(bare.calls.length, 0);
});

test('the http channel names its peer by netstat on Windows too, and finds no ps there', async () => {
  assert.equal(await tcpPeerPid(accepted, netstat(NETSTAT).fn, 'win32'), 4242);
  assert.equal(await tcpPeerPid(accepted, netstat('', '').fn, 'win32'), PEER_NOT_FOUND);
  const socket = { ...accepted };
  assert.equal(
    await verifyTcpPeer({ socket, harnessPid: 5, execFile: netstat(NETSTAT).fn, addon: core([4242, 40, 5]), platform: 'win32' }),
    null,
  );
  const bare = netstat(NETSTAT);
  assert.equal(
    await verifyTcpPeer({ socket, harnessPid: 5, execFile: bare.fn, addon: null, platform: 'win32' }),
    'process 4242 is not the harness or one it started',
  );
  assert.equal(bare.calls.length, 1, 'netstat, and no ps');
});

test("Windows' sage-mcp is the Rust one: resources/core in a package, the core's release build in a checkout", () => {
  assert.equal(
    sageMcpPath({ packaged: true, resourcesPath: 'C:\\App\\resources', platform: 'win32' }),
    path.join('C:\\App\\resources', 'core', 'sage-mcp.exe'),
  );
  assert.equal(sageMcpPath({ repoRoot: '/r', platform: 'win32' }), path.join('/r', 'core', 'target', 'release', 'sage-mcp.exe'));
  assert.equal(sageMcpPath({ repoRoot: '/r', platform: 'darwin' }), path.join('/r', 'native/sage-mcp/build', 'sage-mcp'));
});

test('sage-mcp serves a harness where it exists and the peer check works here, on every platform', () => {
  const exists = (f: string) => f === 'sage-mcp';
  const ready = fakeCore(READY_ROUTES).addon;
  assert.equal(sageMcpReady('sage-mcp', { exists, addon: ready }), true);
  assert.equal(peerCheckReady(ready), true);
  assert.equal(sageMcpReady('missing', { exists, addon: ready }), false);
  assert.equal(sageMcpReady('sage-mcp', { exists, addon: null }), false);
  clearIgnored();
  assert.equal(peerCheckReady(null), false);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['check who connects to the tool sockets'],
    'tools that go missing say why',
  );
  // a core without the check: the route's error is the reason
  const { 'caps.ready': _none, ...without } = READY_ROUTES;
  clearIgnored();
  assert.equal(peerCheckReady(fakeCore(without).addon), false);
  assert.match(recentIgnored().at(-1)?.message ?? '', /no route caps\.ready/);
  // the check runs and fails here, says no, or says something else: the routes alone are no yes
  for (const reply of [false, new Error('no sock_diag'), null, 'true', 1]) {
    assert.equal(peerCheckReady(fakeCore({ ...READY_ROUTES, 'caps.ready': reply }).addon), false, String(reply));
  }
  // by default it asks the file system and the loaded core, whose real check passes here
  assert.equal(sageMcpReady(path.join(import.meta.dirname, 'no-such-sage-mcp')), false);
  assert.equal(peerCheckReady(), true);
});

test("sage-mcp's environment carries SystemRoot on Windows, which Winsock needs, and nothing more elsewhere", () => {
  const base = { SAGE_MCP_SOCKET: '127.0.0.1:5', SAGE_MCP_TOKEN: 't' };
  assert.deepEqual(sageMcpEnv({ socketPath: '127.0.0.1:5', token: 't', platform: 'win32', env: { SYSTEMROOT: 'C:\\Windows' } }), {
    ...base,
    SystemRoot: 'C:\\Windows',
  });
  assert.deepEqual(sageMcpEnv({ socketPath: '127.0.0.1:5', token: 't', platform: 'win32', env: {} }), base);
  assert.deepEqual(sageMcpEnv({ socketPath: '127.0.0.1:5', token: 't', platform: 'darwin', env: { SystemRoot: 'x' } }), base);
});

test('the loopback listener: one start, 127.0.0.1 and a free port, a failed start tried again, a close while opening', async () => {
  const l = new LoopbackListener({ createServer: () => net.createServer() });
  // closed before it ever started: nothing to close
  l.close();
  assert.deepEqual([l.server, l.path, l.listening], [null, null, null]);
  const first = l.listen();
  assert.equal(l.listen(), first);
  const at = await first;
  assert.match(at, /^127\.0\.0\.1:\d+$/);
  assert.equal(l.path, at);
  assert.equal(l.dir, null);
  l.close();
  assert.equal(l.server, null);
  l.close();

  // a server that fails to listen: the error rejects, a later one is only noted, and the next listen starts afresh
  const failing = new net.Server();
  failing.listen = (() => (
    setImmediate(() => (failing.emit('error', new Error('EACCES')), failing.emit('error', new Error('late')))), failing
  )) as any;
  let servers = [failing, net.createServer()];
  const retried = new LoopbackListener({ createServer: () => servers.shift() });
  await assert.rejects(retried.listen(), /EACCES/);
  await new Promise((r) => setImmediate(r));
  assert.equal(retried.listening, null);
  assert.match(await retried.listen(), /^127\.0\.0\.1:\d+$/);
  retried.close();

  // closed before it bound: it lets the port go and the opening fails; a newer start is not touched
  const s = net.createServer();
  servers = [s, net.createServer()];
  const early = new LoopbackListener({ createServer: () => servers.shift() });
  const opening = early.listen();
  early.close();
  const again = early.listen();
  await assert.rejects(opening, /closed while opening/);
  assert.equal(s.listening, false);
  assert.match(await again, /^127\.0\.0\.1:\d+$/);
  assert.equal(early.listening, again);
  early.close();
});

test('the tool socket on Windows listens on 127.0.0.1 and serves a sage-mcp that says hello there', async (t) => {
  const sessions = new ToolSessions();
  const registry = new Registry();
  const ts = new ToolSocket({ sessions, registry, platform: 'win32', verifyPeer: async () => null });
  t.after(() => ts.close());
  const at = await ts.listen();
  assert.match(at, /^127\.0\.0\.1:\d+$/);
  assert.equal(ts.dir, null);
  const issued = sessions.open('k', { harnessPid: 5 });
  const connected = new Promise((r) => ts.once('connected', r));
  // the portable sage-mcp reaches it by that address as the Rust one does
  const stdin = new PassThrough();
  const out: string[] = [];
  const done = runShim({
    env: { SAGE_MCP_SOCKET: at, SAGE_MCP_TOKEN: issued.token },
    stdin,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: () => true },
  });
  assert.deepEqual(await connected, { key: 'k', serverName: issued.serverName, pid: process.pid });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  while (!out.length) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(out[0]), { jsonrpc: '2.0', id: 1, result: { tools: [] } });
  stdin.end();
  assert.equal(await done, 0);
});

test('on Windows itself, netstat names this process as the owner of its own end of a loopback connection', {
  skip: process.platform !== 'win32' && 'netstat -ano as Windows prints it',
}, async (t) => {
  const server = net.createServer();
  t.after(() => server.close());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const accepted = new Promise<net.Socket>((r) => server.once('connection', r));
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  t.after(() => client.destroy());
  const far = await accepted;
  assert.equal(await peerHoldsWindows({ socket: far, pid: process.pid }), null);
  far.destroy();
});
