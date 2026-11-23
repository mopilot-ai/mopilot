// The relay load harness's moving parts against sockets: the relay hosts (in this process and as a child), a peer that reconnects and resends, a fleet through the real relay with socket kills and a restart, and a whole run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import WebSocket, { WebSocketServer } from 'ws';
import { makeBox, makeNonce } from '../scripts/relay-load/payload.mjs';
import { Ledger } from '../scripts/relay-load/ledger.mjs';
import { childRelay, freePort, inProcessRelay } from '../scripts/relay-load/relayHost.mjs';
import { Peer } from '../scripts/relay-load/peer.mjs';
import { Fleet, pickSize } from '../scripts/relay-load/fleet.mjs';
import { makeKeys, idle } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

test('a child relay host starts from its listening line, counts log lines and close codes, and stops on a signal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const script = path.join(dir, 'fake.mjs');
  await writeFile(
    script,
    `console.log(JSON.stringify({event:'close',device:'a',code:1006}));console.log(JSON.stringify({event:'close',device:'b',code:1006}));console.log(JSON.stringify({event:'slow_consumer',device:'a'}));console.log(JSON.stringify({event:'error',device:'a',message:'boom'}));console.log(JSON.stringify({event:'error',device:'a'}));console.log(JSON.stringify({event:'connect',device:'a'}));console.log('partial-no-code');console.log(JSON.stringify({event:'listening',port:1}));console.error('warn');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
  );
  const host = await childRelay({ env: {}, bin: script });
  assert.equal(host.pid, null);
  await host.start();
  assert.ok(host.pid && host.pid > 0);
  assert.match(host.url, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/ws$/);
  await idle(50);
  assert.deepEqual(host.closeCodes, { 1006: 2 });
  assert.deepEqual(host.events, { slow_consumer: 1, error: 2, listening: 1 });
  assert.deepEqual(host.errorSamples, ['boom']);
  assert.ok(host.logLines >= 4);
  assert.match(host.stderr.join(''), /warn/);
  const pid = host.pid as number;
  await host.kill();
  assert.equal(host.pid, null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the killed child is gone');
  await host.kill();
  await host.start();
  await host.stop();
  const crash = path.join(dir, 'crash.mjs');
  await writeFile(crash, `console.error('bad config');process.exit(3);`);
  const broken = await childRelay({ env: {}, bin: crash, port: await freePort() });
  await assert.rejects(broken.start(), /relay exited with 3: bad config/);
  const exited = await childRelay({ env: {}, bin: crash });
  await assert.rejects(exited.start());
  await exited.kill();
});

test('the in-process relay host serves, is killed and comes back on its port with its database', async () => {
  const keys = await makeKeys();
  const pool = new PGlite();
  const host = await inProcessRelay({ env: { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' }, pool });
  await host.start();
  assert.equal((await fetch(`${host.http}/healthz`)).status, 200);
  await host.kill();
  await assert.rejects(fetch(`${host.http}/healthz`));
  await host.start();
  assert.equal((await fetch(`${host.http}/healthz`)).status, 200);
  await host.stop();
  await host.kill();
  await pool.close();
});

/** A stand-in relay that says hello, acks frames and can be told to misbehave. */
async function standIn(behave: (ws: WebSocket, m: any, send: (x: object) => void) => boolean | void) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    const send = (x: object) => ws.send(JSON.stringify(x));
    send({ t: 'hello' });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (behave(ws, m, send)) return;
      if (m.t === 'frame') send({ t: 'ack', pair: m.pair, dir: m.dir, ctr: m.ctr, via: 'mailbox' });
      else if (m.rid) send({ t: 'ok', rid: m.rid });
    });
  });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as any).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    sockets,
    close: () => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(r))),
  };
}

function peerFor(url: string, o: Partial<ConstructorParameters<typeof Peer>[0]> = {}) {
  const ledger = new Ledger();
  const seen: any[] = [];
  const peer = new Peer({
    url,
    token: async () => 'tok',
    role: 'mac',
    index: 3,
    pairId: 'p_load000003',
    ledger,
    sink: { record: (...a) => void seen.push(a) },
    now: Date.now,
    options: { reconnectMs: [5, 10], refreshMs: 30 },
    ...o,
  });
  return { peer, ledger, seen };
}

test('a peer queues frames while down, resends them after a reconnect, retries mailbox_full and answers requests', async () => {
  let fullOnce = true;
  let authSeen = 0;
  const relay = await standIn((ws, m, send) => {
    if (m.t === 'auth') {
      authSeen++;
      return true;
    }
    if (m.t === 'frame' && fullOnce) {
      fullOnce = false;
      send({ t: 'error', code: 'mailbox_full', ctr: m.ctr });
      return true;
    }
    if (m.t === 'pair.register') {
      send({ t: 'ok', rid: 'someone-elses' });
      send({ t: 'ok', rid: m.rid });
      return true;
    }
  });
  const { peer, ledger } = peerFor(relay.url);
  peer.createFrame(100);
  assert.equal(peer.pending.size, 1);
  await peer.start();
  assert.deepEqual((await peer.request({ t: 'pair.register', pair: peer.pairId })).t, 'ok');
  await waitFor(() => !peer.pending.size, 'pending requests to settle');
  assert.equal(peer.pending.size, 0);
  assert.equal(peer.stats.errors.mailbox_full, 1);
  assert.equal(ledger.report().accepted, 1);
  assert.ok(peer.stats.resends >= 1);
  // a cut socket reconnects and the queued frame goes out on the new one
  peer.kill();
  peer.createFrame(50);
  assert.equal(peer.pending.size, 1);
  await waitFor(() => !peer.pending.size, 'pending requests to settle');
  assert.equal(peer.pending.size, 0);
  assert.ok(peer.stats.reconnects >= 1);
  assert.ok(authSeen >= 1);
  assert.equal(Object.values(peer.stats.closes).reduce((a, b) => a + b, 0) >= 1, true);
  peer.stop();
  await relay.close();
});

test('requests fail fast when the socket is down, closes mid-request or the relay never answers', async () => {
  const relay = await standIn((ws, m) => (m.t === 'pair.register' ? (ws.terminate(), true) : m.t === 'pair.join' ? true : undefined));
  const { peer } = peerFor(relay.url, { options: { reconnectMs: [5, 10], refreshMs: 60_000 } });
  assert.equal((await peer.request({ t: 'x' })).code, 'closed');
  await peer.start();
  assert.equal((await peer.request({ t: 'pair.register' })).code, 'closed');
  await waitFor(() => peer.ready, 'the peer to be ready');
  assert.equal((await peer.request({ t: 'pair.join' }, 40)).code, 'timeout');
  peer.stop();
  peer.stop();
  await relay.close();
});

test('a peer that cannot get a token or whose socket constructor throws keeps trying, and a stopped peer stays down', async () => {
  const relay = await standIn(() => undefined);
  let calls = 0;
  const { peer } = peerFor(relay.url, {
    token: async () => {
      if (++calls < 3) throw new Error('no token');
      return 'tok';
    },
  });
  // the first two attempts fail before a socket exists: they are retried, the third connects
  await peer.start().catch(() => undefined);
  assert.ok(peer.ready);
  assert.ok(calls >= 3);
  const bad = peerFor('not a url', {}).peer;
  bad.start().catch(() => undefined);
  await idle(50);
  bad.stop();
  const late = peerFor(relay.url).peer;
  late.stop();
  await late.start().catch(() => undefined);
  assert.equal(late.ready, false);
  peer.stop();
  await relay.close();
});

test('a peer counts a frame that is not ours or is damaged, and acks everything it is given', async () => {
  const acks: any[] = [];
  const relay = await standIn((ws, m) => {
    if (m.t === 'ack') acks.push(m);
    return m.t === 'ack' || undefined;
  });
  const { peer, ledger, seen } = peerFor(relay.url, { role: 'phone' });
  await peer.start();
  const [ws] = relay.sockets;
  const wire = (box: Buffer, dir = 'm2p', ctr = 1) =>
    ws.send(
      JSON.stringify({
        t: 'frame',
        pair: peer.pairId,
        dir,
        ctr,
        nonce: makeNonce(3, dir as 'm2p' | 'p2m', ctr).toString('base64'),
        box: box.toString('base64'),
      }),
    );
  wire(Buffer.from('not ours at all, but long enough to be a box.....'));
  wire(makeBox(9, 'm2p', 1, 64, Date.now()));
  const damaged = makeBox(3, 'm2p', 2, 64, Date.now());
  damaged[40] ^= 1;
  wire(damaged, 'm2p', 2);
  wire(makeBox(3, 'm2p', 3, 64, Date.now()), 'm2p', 3);
  await waitFor(() => !(acks.length < 4), 'four acks');
  assert.equal(acks.length, 4);
  assert.equal(ledger.report().phantom, 2);
  assert.equal(ledger.report().corrupt, 1);
  assert.equal(seen.length, 2);
  peer.stop();
  await relay.close();
});

test('a fleet pairs through the real relay, moves traffic and bursts through socket kills and a relay restart without losing a frame', async () => {
  const keys = await makeKeys();
  const pool = new PGlite();
  const host = await inProcessRelay({ env: { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' }, pool });
  await host.start();
  const fleet = new Fleet({
    url: host.url,
    sign: (user, device, kind) => keys.sign(user, device, { kind }),
    pairs: 3,
    options: { reconnectMs: [5, 20], refreshMs: 60_000 },
  });
  await fleet.setup(2);
  assert.equal(fleet.socketsUp, 6);
  fleet.startTraffic({ macRate: 20, phoneRate: 10 });
  fleet.startTraffic({ macRate: 0, phoneRate: 0 });
  fleet.burst({ pairs: 2, frames: 5, size: 300 });
  await idle(300);
  assert.equal(fleet.killSockets(2), 2);
  await host.kill();
  await idle(100);
  await host.start();
  await idle(300);
  fleet.stopTraffic();
  const depth = async () => Number(((await pool.query('SELECT count(*) AS n FROM remote_durable.frames')) as any).rows[0].n);
  assert.equal(await fleet.drain(30_000, depth), true);
  const r = fleet.report();
  assert.equal(r.ledger.lost, 0);
  assert.equal(r.ledger.duplicated + r.ledger.reordered + r.ledger.corrupt + r.ledger.phantom, 0);
  assert.ok(r.ledger.created >= 10 && r.ledger.created === r.ledger.accepted);
  assert.ok(r.latency.all.count >= 10);
  assert.equal(r.client.unaccepted, 0);
  assert.ok(r.client.reconnects >= 6);
  assert.equal(await fleet.drain(1, async () => 1), false);
  assert.equal(await fleet.drain(), true);
  fleet.stop();
  await host.stop();
  await pool.close();
});

test('frame sizes follow the chat-session mix', () => {
  assert.deepEqual(
    [0, 0.69, 0.7, 0.89, 0.9, 0.97, 0.98, 0.999, 1, 5].map(pickSize),
    [400, 400, 2048, 2048, 16384, 16384, 131072, 131072, 131072, 131072],
  );
});

test('a fleet reports a pair the relay refuses', async () => {
  const relay = await standIn((ws, m, send) =>
    m.t === 'pair.register' ? (send({ t: 'error', code: 'pair_exists', rid: m.rid }), true) : undefined,
  );
  const fleet = new Fleet({ url: relay.url, sign: async () => 'tok', pairs: 2 });
  await assert.rejects(fleet.setup(), /pairing failed for 2 pairs: p_load000000: pair_exists/);
  // the report adds the errors and closes of every peer
  const [a, b] = fleet.peers;
  a.stats.errors = { mailbox_full: 1, bad_dir: 1 };
  b.stats.errors = { mailbox_full: 2 };
  a.stats.closes = { 1006: 1 };
  b.stats.closes = { 1006: 2 };
  const r = fleet.report();
  assert.deepEqual(r.client.errors, { mailbox_full: 3, bad_dir: 1 });
  assert.deepEqual(r.client.closes, { 1006: 3 });
  fleet.stop();
  await relay.close();
});

test('a child relay that never listens is killed after the start timeout, and one that ignores SIGTERM is killed after the kill timeout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const silent = path.join(dir, 'silent.mjs');
  await writeFile(silent, 'setInterval(() => {}, 1000);');
  const never = await childRelay({ env: {}, bin: silent, startTimeoutMs: 100 });
  await assert.rejects(never.start(), /relay not listening after 100 ms/);
  const pid = never.pid as number;
  await waitFor(() => {
    try {
      return !process.kill(pid, 0);
    } catch {
      return true;
    }
  }, 'the silent relay process to exit');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const stubborn = path.join(dir, 'stubborn.mjs');
  await writeFile(
    stubborn,
    `process.on('SIGTERM', () => {}); console.log(JSON.stringify({ event: 'listening', port: 1 })); setInterval(() => {}, 1000);`,
  );
  const host = await childRelay({ env: {}, bin: stubborn, killTimeoutMs: 100 });
  await host.start();
  const started = Date.now();
  await host.stop();
  assert.ok(Date.now() - started < 5000, 'stop gave up waiting for the signal and killed the child');
});

test('a peer rejects when the relay never says hello, leaves no socket when stopped while fetching its token, and flags misrouted and renamed frames', async () => {
  const mute = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => mute.once('listening', r));
  const silent = peerFor(`ws://127.0.0.1:${(mute.address() as any).port}`, {
    options: { reconnectMs: [5, 10], refreshMs: 60_000, helloTimeoutMs: 50 },
  });
  await assert.rejects(silent.peer.start(), /no hello from the relay for p_load000003 mac/);
  silent.peer.stop();
  await new Promise((r) => (mute.clients.forEach((c) => c.terminate()), mute.close(r)));

  const relay = await standIn(() => true);
  let release = () => {};
  const slow = peerFor(relay.url, { token: () => new Promise<string>((resolve) => (release = () => resolve('tok'))) });
  void slow.peer.start().catch(() => undefined);
  slow.peer.stop();
  release();
  await idle(80);
  assert.equal(relay.sockets.length, 0, 'a stopped peer opened no socket');

  const { peer, ledger, seen } = peerFor(relay.url, { role: 'phone' });
  await peer.start();
  const [ws] = relay.sockets;
  const wire = (o: object) =>
    ws.send(
      JSON.stringify({
        t: 'frame',
        pair: peer.pairId,
        dir: 'm2p',
        ctr: 1,
        nonce: makeNonce(3, 'm2p', 1).toString('base64'),
        box: makeBox(3, 'm2p', 1, 64, Date.now()).toString('base64'),
        ...o,
      }),
    );
  wire({ dir: 'p2m', box: makeBox(3, 'p2m', 1, 64, Date.now()).toString('base64') });
  wire({ pair: 'p_load000009' });
  wire({ nonce: makeNonce(3, 'm2p', 2).toString('base64') });
  wire({});
  await waitFor(() => !(ledger.report().phantom + ledger.report().corrupt + seen.length < 4), 'four ledger outcomes');
  assert.equal(ledger.report().phantom, 2, 'a frame for the wrong direction or pair is not ours');
  assert.equal(ledger.report().corrupt, 1, 'a changed nonce is corruption');
  assert.equal(seen.length, 2);
  peer.stop();
  await relay.close();
});

test('killSockets cuts only the connected sockets and reports how many it cut', async () => {
  const relay = await standIn(() => undefined);
  const fleet = new Fleet({ url: relay.url, sign: async () => 'tok', pairs: 1, options: { reconnectMs: [200, 300], refreshMs: 60_000 } });
  await fleet.pairs[0].mac.start();
  assert.equal(fleet.killSockets(5), 1);
  await idle(30);
  assert.equal(fleet.killSockets(5), 0);
  fleet.stop();
  await relay.close();
});

test('a drain keeps waiting while the database cannot answer the depth, and gives up at its deadline', async () => {
  const fleet = new Fleet({ url: 'ws://127.0.0.1:1', sign: async () => 'tok', pairs: 1 });
  let calls = 0;
  const depth = async () => {
    if (++calls < 3) throw new Error('connection reset');
    return 0;
  };
  assert.equal(await fleet.drain(30_000, depth), true);
  assert.equal(calls, 3);
  assert.equal(await fleet.drain(300, async () => Promise.reject(new Error('down'))), false);
  fleet.stop();
});
