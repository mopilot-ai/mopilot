// The SSH tunnel to a remote Host (electron/host/sshTunnel.cjs) with a fake ssh process, a fake network and a mocked clock: connect, drop, backoff (A6), sharing (A1), release while connecting (A3), a silent socket (B5), garbage (B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld, tick } from './support/host-wire-kit.ts';
const require = createRequire(import.meta.url);
const { createTunnelPool, mergeSshArgs, backoffDelay, BACKOFF } = require('../electron/host/sshTunnel.cjs');

test('connect: ssh forwards the local socket to the Host socket and ready waits for a ping answer', async (t) => {
  const w = hostWorld(t);
  w.net.mode = 'refuse';
  const tun = w.tunnel({ sshArgs: ['-p', '2222'] });
  const seen: string[] = [];
  tun.onState((s: string) => seen.push(s));
  const lease = tun.acquire();
  assert.equal(tun.state, 'connecting');
  assert.equal(w.children.length, 1);
  const args = w.children[0].args;
  assert.ok(args.includes('-N') && args.includes('BatchMode=yes') && args.includes('ExitOnForwardFailure=yes'));
  // L3: the machine gets neither this Mac's ssh agent nor its display, ahead of the user's own options so theirs cannot turn them on
  assert.ok(args.includes('ForwardAgent=no') && args.includes('ForwardX11=no'));
  assert.ok(args.indexOf('ForwardAgent=no') < args.indexOf('-p'));
  assert.equal(args[args.indexOf('-L') + 1], `${tun.localSocket}:/run/host.sock`);
  assert.deepEqual(args.slice(-4), ['-p', '2222', '--', 'build-box']);
  // ssh is up but the local socket is not there yet: the probe tries again
  await tick();
  w.net.mode = 'host';
  w.clock.advance(200);
  await tick();
  await lease.ready;
  assert.equal(tun.state, 'online');
  assert.equal(tun.reason, '');
  assert.deepEqual(seen, ['connecting', 'online']);
  assert.equal(lease.socketPath, tun.localSocket);
});

test("a drop takes the tunnel offline with ssh's own words, then it reconnects", async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const lease = tun.acquire();
  await tick();
  await lease.ready;
  w.children[0].die(255, 'Connection reset by peer\n');
  assert.equal(tun.state, 'offline');
  assert.equal(tun.reason, 'Connection reset by peer');
  w.clock.advance(1000);
  assert.equal(w.children.length, 2);
  await tick();
  assert.equal(tun.state, 'online');
});

test('A6: backoff doubles to a cap, is quiet inside the window, fires at its end, and resets once online', async (t) => {
  const w = hostWorld(t);
  w.net.mode = 'refuse';
  const tun = w.tunnel({ backoff: { baseMs: 100, maxMs: 350 }, connectTimeoutMs: 0 });
  tun.acquire();
  // each attempt ends at once (no probe time); the waits are 100, 200, 350, 350
  const waits = [100, 200, 350, 350];
  for (const [i, wait] of waits.entries()) {
    await tick();
    assert.equal(w.children.length, i + 1);
    assert.equal(tun.state, 'offline');
    w.clock.advance(wait - 1);
    assert.equal(w.children.length, i + 1, 'nothing starts inside the window');
    w.clock.advance(1);
    assert.equal(w.children.length, i + 2, 'the timer fires at the end of the window');
  }
  w.net.mode = 'host';
  w.clock.advance(0);
  await tick();
  // online for good: long enough to earn a fresh backoff
  w.clock.advance(30_000);
  w.children[w.children.length - 1].die();
  const n = w.children.length;
  w.clock.advance(99);
  assert.equal(w.children.length, n);
  w.clock.advance(1);
  assert.equal(w.children.length, n + 1, 'the wait starts over from the base after an online spell');
  assert.deepEqual(
    [0, 1, 2, 3, 40].map((a) => backoffDelay(a, { baseMs: 100, maxMs: 350 })),
    [100, 200, 350, 350, 350],
  );
});

test('A1: two windows share one tunnel; closing one keeps it, the last closes it', async (t) => {
  const w = hostWorld(t);
  const pool = createTunnelPool({ dir: w.dir, connect: w.net.connect, allowed: () => true });
  const a = pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' });
  const b = pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' });
  const other = pool.get({ destination: 'other', remoteSocket: '/run/host.sock', sshArgs: ['-J', 'jump'] });
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.notEqual(a.localSocket, other.localSocket);
  const l1 = a.acquire();
  const l2 = b.acquire();
  await tick();
  await Promise.all([l1.ready, l2.ready]);
  assert.equal(w.children.length, 1);
  assert.equal(a.leases, 2);
  l1.release();
  l1.release();
  assert.equal(a.leases, 1);
  assert.equal(a.state, 'online');
  assert.deepEqual(w.children[0].killed, []);
  l2.release();
  assert.deepEqual(w.children[0].killed, ['SIGTERM']);
  assert.equal(a.state, 'offline');
  // a third window later starts a fresh one
  a.acquire();
  assert.equal(w.children.length, 2);
  // a lease taken while online is ready at once
  await tick();
  await a.acquire().ready;
  assert.equal(w.children.length, 2);
});

test('A3: releasing while connecting settles ready false and starts nothing, not even a retry', async (t) => {
  const w = hostWorld(t);
  w.net.mode = 'refuse';
  const tun = w.tunnel();
  const lease = tun.acquire();
  lease.release();
  assert.equal(await lease.ready, false);
  assert.equal(tun.state, 'offline');
  await tick();
  w.clock.advance(120_000);
  assert.equal(w.children.length, 1);
  assert.equal(w.clock.pending, 0);
  // and during a backoff wait
  const again = tun.acquire();
  await tick();
  w.children[1].die();
  again.release();
  assert.equal(w.clock.pending, 0);
  w.clock.advance(120_000);
  assert.equal(w.children.length, 2);
});

test('B5: a socket that stays open and answers nothing is no connection; the attempt ends at its deadline', async (t) => {
  const w = hostWorld(t);
  w.net.mode = 'silent';
  const tun = w.tunnel({ helloMs: 1000, connectTimeoutMs: 2500, probeMs: 100 });
  const lease = tun.acquire();
  await tick();
  assert.equal(tun.state, 'connecting');
  w.clock.advance(1000);
  assert.equal(w.net.sockets[0].destroyed, true);
  await tick();
  w.clock.advance(100);
  await tick();
  w.clock.advance(1000);
  await tick();
  w.clock.advance(100);
  await tick();
  w.clock.advance(1000);
  await tick();
  assert.equal(tun.state, 'offline');
  assert.equal(tun.reason, 'The host did not answer in time.');
  assert.deepEqual(w.children[0].killed, ['SIGTERM']);
  lease.release();
});

test('B2: garbage, a close, and replies that are not pong never open the tunnel', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel({ helloMs: 1000, probeMs: 100, connectTimeoutMs: 100_000 });
  tun.acquire();
  w.net.hold.add('ping');
  await tick();
  const s0 = w.net.sockets[0];
  s0.feed('not json\n');
  await tick();
  assert.equal(s0.destroyed, true);
  w.clock.advance(100);
  await tick();
  w.net.sockets[1].feed({ id: 0, result: 'something else' });
  assert.equal(w.net.sockets[1].destroyed, false);
  w.net.sockets[1].emit('close');
  w.clock.advance(100);
  await tick();
  assert.equal(tun.state, 'connecting');
  w.net.hold.clear();
  w.clock.advance(1000);
  await tick();
  w.clock.advance(100);
  await tick();
  assert.equal(tun.state, 'online');
});

test('ssh that cannot start: a throw, an error event, or an exit before the probe, each retried with backoff', async (t) => {
  const boom = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' });
  const w = hostWorld(t, { spawnThrows: boom });
  const tun = w.tunnel();
  const lease = tun.acquire();
  assert.equal(tun.state, 'offline');
  assert.equal(tun.reason, 'spawn ssh ENOENT');
  w.noSpawnError();
  w.clock.advance(1000);
  assert.equal(w.children.length, 1);
  w.children[0].emit('error', new Error('spawn ssh EACCES'));
  assert.equal(tun.reason, 'spawn ssh EACCES');
  w.clock.advance(2000);
  w.children[1].die(255);
  assert.equal(tun.reason, 'ssh ended (255).');
  // a late event from the dead attempt changes nothing
  w.children[1].die(1, 'late');
  assert.equal(tun.reason, 'ssh ended (255).');
  w.children[0].emit('exit', 0, null);
  assert.equal(tun.state, 'offline');
  lease.release();
});

test('fail() takes a working tunnel down; it does nothing when already offline; late probe results are ignored', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const lease = tun.acquire();
  await tick();
  tun.fail('the connection through it broke');
  assert.equal(tun.state, 'offline');
  assert.equal(tun.reason, 'the connection through it broke');
  tun.fail('again');
  assert.equal(tun.reason, 'the connection through it broke');
  assert.deepEqual(w.children[0].killed, ['SIGTERM']);
  // a probe still in flight from the dead attempt does not bring the tunnel online
  w.net.sockets[0].emit('connect');
  w.net.sockets[0].feed({ id: 0, result: 'pong' });
  assert.equal(tun.state, 'offline');
  const off = tun.onState(() => assert.fail('unsubscribed'));
  off();
  lease.release();
  assert.equal(tun.state, 'offline');
  assert.equal(tun.reason, '');
});

test('the lease released while waiting out a backoff after an online spell leaves no state change behind', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const lease = tun.acquire();
  await tick();
  lease.release();
  assert.equal(tun.state, 'offline');
  // an unrelated socket event after release changes nothing
  w.net.sockets[0].emit('close');
  assert.equal(tun.state, 'offline');
});

test('a probe answered after its attempt ended does not bring the tunnel online', async (t) => {
  const w = hostWorld(t);
  w.net.hold.add('ping');
  const tun = w.tunnel();
  const lease = tun.acquire();
  await tick();
  w.children[0].die(255, 'refused');
  w.net.sockets[0].feed({ id: 0, result: 'pong' });
  assert.equal(tun.state, 'offline');
  w.net.sockets[0].emit('close');
  assert.equal(tun.state, 'offline');
  lease.release();
});

test('A6: a tunnel that falls over soon after coming online keeps climbing the backoff instead of starting over', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel({ backoff: { baseMs: 100, maxMs: 10_000 } });
  tun.acquire();
  await tick();
  w.children[0].die();
  w.clock.advance(100);
  await tick();
  w.clock.advance(1000);
  w.children[1].die();
  // the second drop waits 200, not 100: the online spell was short
  w.clock.advance(199);
  assert.equal(w.children.length, 2);
  w.clock.advance(1);
  assert.equal(w.children.length, 3);
});

test('a destination that starts with a dash is not an ssh option, and an existing socket folder is narrowed to its owner', async (t) => {
  const w = hostWorld(t);
  fs.chmodSync(w.dir, 0o755);
  const tun = w.tunnel({ destination: '-oProxyCommand=evil' });
  tun.acquire();
  const args = w.children[0].args;
  assert.deepEqual(args.slice(-2), ['--', '-oProxyCommand=evil']);
  assert.equal(fs.statSync(w.dir).mode & 0o777, 0o700);
});

test('ssh runs in the environment it is given, the process one by default', async (t) => {
  const w = hostWorld(t);
  const mine = { PATH: '/login/shell/path' };
  w.tunnel({ env: () => mine }).acquire();
  assert.equal(w.spawnOpts[0].env, mine);
  w.tunnel({ localSocket: `${w.dir}/two.sock` }).acquire();
  assert.equal(w.spawnOpts[1].env, process.env);
});

test('closed alpha: without Host access the pool makes no tunnel, so no ssh, remote Host or heartbeat starts', (t) => {
  const w = hostWorld(t);
  let allowed = false;
  const pool = createTunnelPool({ dir: w.dir, connect: w.net.connect, allowed: () => allowed });
  assert.throws(() => pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' }), /not available/);
  assert.equal(w.children.length, 0);
  allowed = true;
  assert.ok(pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' }));
  // the app's own gate is closed until opened
  assert.throws(() => createTunnelPool({ dir: w.dir }).get({ destination: 'x', remoteSocket: '/y' }), /not available/);
});

test('closed alpha: losing access takes every tunnel down, even with a lease held, and a new one needs access again', async (t) => {
  const w = hostWorld(t);
  let notify: (ok: boolean) => void = () => {};
  let allowed = true;
  const pool = createTunnelPool({ dir: w.dir, connect: w.net.connect, allowed: () => allowed, watch: (cb: any) => (notify = cb) });
  const tunnel = pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' });
  const lease = tunnel.acquire();
  await tick();
  await lease.ready;
  assert.equal(tunnel.state, 'online');
  notify(true);
  assert.equal(tunnel.state, 'online', 'a grant changes nothing');
  allowed = false;
  notify(false);
  assert.equal(tunnel.state, 'offline');
  assert.equal(tunnel.leases, 0);
  lease.release();
  assert.throws(() => pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' }), /not available/);
  allowed = true;
  assert.notEqual(pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' }), tunnel);
  // a lease still waiting when access goes settles false
  const again = pool.get({ destination: 'build-box', remoteSocket: '/run/host.sock' });
  w.net.mode = 'refuse';
  const waiting = again.acquire();
  allowed = false;
  notify(false);
  assert.equal(await waiting.ready, false);
});

test('closeAll stops ssh for every Host while leases are held, as the app quits', async (t) => {
  const w = hostWorld(t);
  const pool = createTunnelPool({ dir: w.dir, connect: w.net.connect, allowed: () => true, watch: () => undefined });
  const a = pool.get({ destination: 'box-a', remoteSocket: '/run/host.sock' });
  const b = pool.get({ destination: 'box-b', remoteSocket: '/run/host.sock' });
  const leases = [a.acquire(), b.acquire()];
  await tick();
  await Promise.all(leases.map((l) => l.ready));
  assert.deepEqual([a.state, b.state, a.leases, b.leases], ['online', 'online', 1, 1]);
  pool.closeAll();
  assert.deepEqual([a.state, b.state, a.leases, b.leases], ['offline', 'offline', 0, 0]);
  // a Host asked for after the quit starts a fresh tunnel
  assert.notEqual(pool.get({ destination: 'box-a', remoteSocket: '/run/host.sock' }), a);
});

test('a data folder too long for a socket path keeps the forwarded sockets in a short temp folder, one per data folder (B1)', async (t) => {
  const w = hostWorld(t);
  const long = path.join(w.dir, 'deeper-'.repeat(12));
  const a = createTunnelPool({ dir: long, allowed: () => true }).get({ destination: 'box', remoteSocket: '/run/host.sock' });
  const b = createTunnelPool({ dir: `${long}-other`, allowed: () => true }).get({ destination: 'box', remoteSocket: '/run/host.sock' });
  const short = createTunnelPool({ dir: '/tmp/hp', allowed: () => true }).get({ destination: 'box', remoteSocket: '/run/host.sock' });
  assert.ok(a.localSocket.startsWith(path.join(os.tmpdir(), 'mopilot-host-')));
  assert.notEqual(path.dirname(a.localSocket), path.dirname(b.localSocket));
  assert.equal(path.dirname(short.localSocket), '/tmp/hp', 'a data folder that fits is used as it is');
});

test('#4053: a target with no ssh options keeps the pool defaults, a target key is added, and a repeated option is dropped', async (t) => {
  const w = hostWorld(t);
  const defaults = ['-i', '/run/key', '-o', 'IdentitiesOnly=yes'];
  const pool = createTunnelPool({ dir: w.dir, connect: w.net.connect, allowed: () => true, sshArgs: defaults });
  const argsOf = async (target: any) => {
    const n = w.children.length;
    const l = pool.get(target).acquire();
    await tick();
    await l.ready;
    return w.children[n].args.slice(w.children[n].args.indexOf('-L') + 2, -2);
  };
  assert.deepEqual(
    await argsOf({ destination: 'a', remoteSocket: '/s', sshArgs: [] }),
    defaults,
    'an empty list does not wipe the defaults',
  );
  assert.deepEqual(await argsOf({ destination: 'b', remoteSocket: '/s' }), defaults, 'no list at all');
  assert.deepEqual(
    await argsOf({ destination: 'c', remoteSocket: '/s', sshArgs: ['-i', '/own', '-o', 'IdentitiesOnly=yes'] }),
    ['-i', '/own', '-o', 'IdentitiesOnly=yes', '-i', '/run/key'],
    "the target's key comes first and adds to the default; IdentitiesOnly is not repeated",
  );
});

test('#4053: mergeSshArgs treats a flag with its value as one option and lets a lone flag or missing list pass', () => {
  assert.deepEqual(mergeSshArgs(undefined, undefined), []);
  assert.deepEqual(mergeSshArgs(['-v', '-p', '1'], ['-v', '-p']), ['-v', '-p']);
  assert.deepEqual(
    mergeSshArgs(['-p', '2200', '-l', 'a', '-i', 'k'], ['-p', '2222', '-i', 'o']),
    ['-p', '2222', '-i', 'o', '-l', 'a', '-i', 'k'],
    "the target's port replaces the default's, keys add",
  );
  assert.deepEqual(mergeSshArgs(['-p2200', '-J', 'x'], ['-p2222']), ['-p2222', '-J', 'x'], 'an attached port too');
});

test('#4053: target singleton options replace defaults in separate and attached form', () => {
  for (const flag of ['-p', '-J', '-l', '-F']) {
    assert.deepEqual(mergeSshArgs([flag, 'default'], [flag, 'target']), [flag, 'target']);
    assert.deepEqual(mergeSshArgs([`${flag}default`], [flag, 'target']), [flag, 'target']);
    assert.deepEqual(mergeSshArgs([flag, 'default'], [`${flag}target`]), [`${flag}target`]);
  }
  assert.deepEqual(mergeSshArgs(['-i', 'key', '-o', 'BatchMode=yes'], ['-i', 'key', '-o', 'BatchMode=no']), [
    '-i',
    'key',
    '-o',
    'BatchMode=no',
    '-o',
    'BatchMode=yes',
  ]);
  assert.deepEqual(mergeSshArgs(['-i', 'key\nfile'], ['-i', 'key']), ['-i', 'key', '-i', 'key\nfile']);
});

test('#5134: the default backoff doubles from 1 s and never waits more than 10 s for the next attempt, so a machine that is back is reached within ten seconds', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 40].map((a) => backoffDelay(a, BACKOFF)),
    [1000, 2000, 4000, 8000, 10_000, 10_000, 10_000],
  );
});
