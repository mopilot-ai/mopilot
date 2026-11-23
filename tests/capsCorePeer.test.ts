// The capability sockets' peer checks on what the Rust core answers (electron/capabilities/mcp/socket.cjs, httpMcp.cjs,
// crates/caps): the core's word is the only source, and anything but a plain yes is a refusal. Real sockets and processes
// through the real core: tests/capsRealPeer.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeCore } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const { verifyPeer, peerHolds, startedBy, ancestryOf, MAX_DEPTH } = require('../electron/capabilities/mcp/socket.cjs');
const { verifyTcpPeer } = require('../electron/capabilities/httpMcp.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const socket = { _handle: { fd: 12 } };
const NOT_STARTED = 'process 500 is not one the harness started';
const NOT_CONNECTED = 'process 500 is not the one connected';

test('the core vouches for a process the harness started that is the peer, asking for the ancestry and then the peer', async () => {
  const c = fakeCore({ 'caps.ancestry': [500, 400, 300], 'caps.peerPid': 500 });
  assert.equal(await verifyPeer({ socket, platform: 'darwin', pid: 500, harnessPid: 300, addon: c.addon }), null);
  assert.deepEqual(c.asked, ['caps.ancestry 500', 'caps.peerPid 12']);
  const linux = fakeCore({ 'caps.ancestry': [500, 300], 'caps.peerPid': 500 });
  assert.equal(await verifyPeer({ socket, platform: 'linux', pid: 500, harnessPid: 300, addon: linux.addon }), null);
});

test('the refusals before the core is asked keep their results', async () => {
  const c = fakeCore({ 'caps.ancestry': [500, 300], 'caps.peerPid': 500 });
  const check = (o: object) => verifyPeer({ socket, platform: 'darwin', pid: 500, harnessPid: 300, addon: c.addon, ...o });
  for (const pid of [1, 0, -5, 2.5, '500', null, undefined]) assert.equal(await check({ pid }), 'no pid');
  for (const harnessPid of [null, undefined, '300']) assert.equal(await check({ harnessPid }), 'the session has no harness process');
  assert.deepEqual(c.asked, []);
  assert.equal(await check({ pid: 300 }), 'process 300 is not one the harness started', 'the harness itself');
  assert.deepEqual(c.asked, [], 'the harness itself needs no reading');
  for (const handle of [undefined, null, {}, { fd: -1 }, { fd: '12' }])
    assert.equal(await check({ socket: { _handle: handle } }), 'no socket', JSON.stringify(handle));
});

test('a process the harness did not start is refused, however the chain reads', async () => {
  const check = (chain: unknown) =>
    verifyPeer({
      socket,
      platform: 'darwin',
      pid: 500,
      harnessPid: 300,
      addon: fakeCore({ 'caps.ancestry': chain, 'caps.peerPid': 500 }).addon,
    });
  assert.equal(await check([500, 400, 200]), NOT_STARTED);
  // gone, so the chain has only itself; the harness named first is the process's own pid, never its ancestor
  assert.equal(await check([500]), NOT_STARTED);
  assert.equal(await check([300, 500]), NOT_STARTED);
  // what no chain is
  for (const reply of [null, {}, 'x', 300, { 0: 500, 1: 300, length: 2 }])
    assert.equal(await check(reply), NOT_STARTED, JSON.stringify(reply));
  // eight levels up is the limit: a loop in a reading ends there too
  const up = (depth: number) => [500, ...Array.from({ length: depth - 1 }, (_, i) => 1000 + i), 300];
  assert.equal(await check(up(MAX_DEPTH)), null);
  assert.equal(await check(up(MAX_DEPTH + 1)), NOT_STARTED);
  assert.equal(await check([500, 501, 500, 501, 500, 501, 500, 501, 500, 501]), NOT_STARTED);
});

test('a peer the kernel names otherwise, or no answer, is a refusal: nothing else is asked', async () => {
  const holds = (reply: unknown, pid: unknown = 500) => {
    const c = fakeCore({ 'caps.peerPid': reply });
    return peerHolds({ socket, platform: 'darwin', pid, addon: c.addon });
  };
  assert.equal(await holds(500), null);
  assert.equal(await holds(777), NOT_CONNECTED);
  // the core failed, or said something that is no pid
  for (const reply of [new Error('not a socket'), null, '500', 500.5, {}, [500], true])
    assert.equal(await holds(reply), 'socket not found');
  // a process the kernel can't name here (another pid namespace reads 0), or init, is nobody: a claim of it gets nothing
  assert.equal(await holds(0), 'socket not found');
  assert.equal(await holds(0, 0), 'socket not found');
  assert.equal(await holds(1, 1), 'socket not found');
  // a claim that is no pid never matches a core that failed
  assert.equal(await holds(null, null), 'socket not found');
  assert.equal(await holds(new Error('x'), undefined), 'socket not found');
  // no core at all
  assert.equal(await peerHolds({ socket, platform: 'linux', pid: 500, addon: null }), 'socket not found');
  assert.equal(await verifyPeer({ socket, platform: 'linux', pid: 500, harnessPid: 300, addon: null }), NOT_STARTED);
  assert.equal(await peerHolds({ socket: { _handle: null }, platform: 'darwin', pid: 500, addon: null }), 'no socket');
  // what was missing is noted, not swallowed
  assert.ok(recentIgnored().some((n: any) => n.context === 'read who holds a socket'));
});

test('Linux and macOS take the same path; Windows keeps netstat and reads the ancestry from the core', async () => {
  for (const platform of ['linux', 'darwin']) {
    const c = fakeCore({ 'caps.peerPid': 500 });
    const exec = () => assert.fail('no command runs');
    assert.equal(await peerHolds({ socket, platform, pid: 500, execFile: exec, addon: c.addon }), null);
  }
  const row = '  TCP    127.0.0.1:50001   127.0.0.1:4000   ESTABLISHED   500\r\n';
  const netstat = (_c: string, _a: string[], _o: object, done: (e: null, s: string) => void) => done(null, row);
  const tcp = { remotePort: 50001, localPort: 4000 };
  const c = fakeCore({ 'caps.ancestry': [500, 300] });
  assert.equal(await verifyPeer({ socket: tcp, platform: 'win32', pid: 500, harnessPid: 300, execFile: netstat, addon: c.addon }), null);
  assert.deepEqual(c.asked, ['caps.ancestry 500']);
  assert.equal(
    await verifyPeer({ socket: tcp, platform: 'win32', pid: 500, harnessPid: 300, execFile: netstat, addon: null }),
    NOT_STARTED,
  );
});

test('startedBy: the process itself or up to eight levels; no pid, no reply or a bad one is not started', async () => {
  const c = fakeCore({ 'caps.ancestry': [9, 8, 7] });
  assert.equal(await startedBy(9, 7, c.addon), true);
  assert.equal(await startedBy(9, 9, c.addon), true);
  assert.equal(await startedBy(9, 6, c.addon), false);
  c.asked.length = 0;
  for (const pid of [null, 1, 0]) assert.equal(await startedBy(pid, 7, c.addon), false);
  assert.deepEqual(c.asked, [], 'no pid to read');
  assert.equal(await startedBy(9, 7, fakeCore({ 'caps.ancestry': new Error('no table') }).addon), false);
  assert.equal(await startedBy(9, 7, fakeCore({ 'caps.ancestry': { 9: 7 } }).addon), false);
  assert.equal(await startedBy(9, 7, null), false);
  // the harness itself is no exception: with no reading there is no yes
  assert.equal(await startedBy(9, 9, null), false);
  assert.equal(await startedBy(9, 9, fakeCore({ 'caps.ancestry': new Error('no table') }).addon), false);
  const long = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(await startedBy(100, 107, fakeCore({ 'caps.ancestry': long }).addon), true);
  assert.equal(await startedBy(100, 108, fakeCore({ 'caps.ancestry': long }).addon), false);
  assert.deepEqual(await ancestryOf(9, fakeCore({ 'caps.ancestry': [9, 8] }).addon), [9, 8]);
  assert.equal(await ancestryOf(null), null);
});

test('the http channel: lsof names the peer, and the core alone says who started it', async () => {
  const runs: string[] = [];
  const exec = (cmd: string, _a: string[], _o: object, done: (e: null, s: string) => void) => {
    runs.push(cmd);
    done(null, `p${process.pid}\nf12\nn127.0.0.1:1->127.0.0.1:2\np9\nf4\nn127.0.0.1:2->127.0.0.1:1\n`);
  };
  const tcpSocket = { _handle: { fd: 12 }, localPort: 1, remotePort: 2 };
  const c = fakeCore({ 'caps.ancestry': [9, 8, 7] });
  assert.equal(await verifyTcpPeer({ socket: tcpSocket, harnessPid: 7, execFile: exec, addon: c.addon }), null);
  assert.match(await verifyTcpPeer({ socket: tcpSocket, harnessPid: 6, execFile: exec, addon: c.addon }), /not the harness/);
  // a core that fails is a refusal
  assert.match(await verifyTcpPeer({ socket: tcpSocket, harnessPid: 7, execFile: exec, addon: null }), /not the harness/);
  const failing = fakeCore({ 'caps.ancestry': new Error('no table') });
  assert.match(await verifyTcpPeer({ socket: tcpSocket, harnessPid: 7, execFile: exec, addon: failing.addon }), /not the harness/);
  assert.deepEqual(new Set(runs), new Set(['/usr/sbin/lsof']));
});
