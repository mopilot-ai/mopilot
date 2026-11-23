// The app's host lane (electron/host/relayLane.cjs) and a machine's relay tunnel (relayTunnel.cjs) over a fake relay socket: the lane
// opens on `?as=hostlink`, tracks each Host's presence from the hello, `peer` events, a removed pair and `peer_offline`, routes
// frames by pair, keeps a revoke on disk until the relay answers it, and waits for itself to open; the tunnel is offline with a
// reason until the Host is on the relay, opens a session then, retries after a failed one, and lets go of everything when released.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createRelaySession } from '../shared/host/relaySession.mjs';

const require = createRequire(import.meta.url);
const { createRelayLane, laneUrl } = require('../electron/host/relayLane.cjs');
const { createRelayTunnel, RETRY_MS } = require('../electron/host/relayTunnel.cjs');
const prim = createNodePrimitives();
const PAIR = 'p_hostpair01';
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await wait();
  }
  throw new Error(`timed out: ${what}`);
}

function fakeRelay({ hello = [{ pair: PAIR, peerOnline: false }], answer = (m: any) => ({ t: 'ok', op: m.t, rid: m.rid }) as any } = {}) {
  const sockets: any[] = [];
  const createSocket = (url: string, headers: any) => {
    const s: any = { url, headers, sent: [] as any[], onopen: null, onmessage: null, onclose: null };
    s.say = (m: object) => s.onmessage?.({ data: JSON.stringify(m) });
    s.send = (text: string) => {
      const m = JSON.parse(text);
      s.sent.push(m);
      if (m.rid) {
        const a = answer(m);
        if (a) setImmediate(() => s.say(a));
      }
    };
    s.close = (code: number) => s.onclose?.({ code });
    sockets.push(s);
    setImmediate(() => (s.onopen?.(), s.say({ t: 'hello', pairs: hello })));
    return s;
  };
  return { sockets, createSocket, last: () => sockets[sockets.length - 1] };
}
const scratch = (t: any) => {
  const d = fs.realpathSync(fs.mkdtempSync('/tmp/rlane-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('laneUrl puts the lane on the query', () => {
  assert.equal(laneUrl('wss://r/v1/ws'), 'wss://r/v1/ws?as=hostlink');
  assert.equal(laneUrl('wss://r/v1/ws?x=1'), 'wss://r/v1/ws?x=1&as=hostlink');
});

test('the lane tracks presence, routes frames by pair, and keeps a revoke until the relay answers it', async (t) => {
  const dir = scratch(t);
  let refuse = true;
  const relay = fakeRelay({
    hello: [{ pair: PAIR, peerOnline: true }, { nope: 1 } as any],
    answer: (m) => (m.t === 'host.revoke' && refuse ? { t: 'error', code: 'busy', rid: m.rid } : { t: 'ok', op: m.t, rid: m.rid }),
  });
  const lane = createRelayLane({
    url: () => 'wss://r/v1/ws',
    getToken: async () => 'tok',
    revokesFile: path.join(dir, 'revokes.json'),
    createSocket: relay.createSocket,
  });
  t.after(() => lane.stop());
  assert.equal(lane.peerOnline(PAIR), false);
  // a revoke while the lane is down is kept and the lane is opened for it; the relay refuses it once
  await lane.revoke('h_gone000000000000001');
  assert.deepEqual(lane.pendingRevokes(), ['h_gone000000000000001']);
  await lane.revoke('h_gone000000000000001');
  assert.deepEqual(lane.pendingRevokes(), ['h_gone000000000000001'], 'kept once');
  await lane.whenOpen();
  assert.equal(relay.last().url, 'wss://r/v1/ws?as=hostlink');
  assert.equal(relay.last().headers.authorization, 'Bearer tok');
  assert.equal(lane.state, 'open');
  assert.equal(lane.peerOnline(PAIR), true);
  await until(() => relay.last().sent.some((m: any) => m.t === 'host.revoke'), 'the revoke is sent on open');
  await wait(10);
  assert.deepEqual(lane.pendingRevokes(), ['h_gone000000000000001'], 'refused: still kept');
  refuse = false;
  await lane.revoke('h_gone000000000000001');
  assert.deepEqual(lane.pendingRevokes(), []);
  // frames go to the route of their pair; presence changes reach it and every watcher
  const frames: any[] = [];
  const peers: boolean[] = [];
  let changes = 0;
  const offWatch = lane.onChange(() => changes++);
  const off = lane.route(PAIR, { onFrame: (f: any) => frames.push(f), onPeer: (o: boolean) => peers.push(o) });
  relay.last().say({ t: 'frame', pair: PAIR, dir: 'p2m', ctr: 1, nonce: 'AA==', box: 'AA==' });
  relay.last().say({ t: 'frame', pair: 'p_other0001', dir: 'p2m', ctr: 1, nonce: 'AA==', box: 'AA==' });
  assert.equal(frames.length, 1);
  relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: false });
  relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
  relay.last().say({ t: 'error', code: 'peer_offline', pair: PAIR });
  relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
  relay.last().say({ t: 'event', ev: 'pair.removed', pair: PAIR });
  relay.last().say({ t: 'error', code: 'other', pair: PAIR });
  relay.last().say({ t: 'event', ev: 'other' });
  assert.deepEqual(peers, [false, true, false, true, false]);
  assert.ok(changes >= 5);
  assert.equal(lane.send({ pair: PAIR, dir: 'm2p', ctr: 1, nonce: 'AA==', box: 'AA==' }), true);
  // a route replaced by another is not removed by the old one's off
  const other = { onFrame: () => undefined, onPeer: () => undefined };
  lane.route(PAIR, other);
  off();
  relay.last().say({ t: 'frame', pair: PAIR, dir: 'p2m', ctr: 2, nonce: 'AA==', box: 'AA==' });
  assert.equal(frames.length, 1);
  offWatch();
  // the lane goes down: every Host reads offline, and a live frame is not sent
  relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
  relay.last().onclose({ code: 1006 });
  assert.equal(lane.peerOnline(PAIR), false);
  assert.equal(lane.send({ pair: PAIR, dir: 'm2p', ctr: 2, nonce: 'AA==', box: 'AA==' }), false);
  await lane.whenOpen();
  await lane.register({ host: 'h_x', pair: PAIR, hash: 'aa' });
});

test('whenOpen rejects when the lane cannot open in time; an unreadable revokes file reads as none', async (t) => {
  const dir = scratch(t);
  // a revokes file of an earlier build lists bare ids: any lane may send them
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ hosts: ['h_old0000000000000001', 7] }));
  const old = createRelayLane({ url: () => 'wss://r/v1/ws', getToken: async () => null, revokesFile: path.join(dir, 'old.json') });
  assert.deepEqual(old.pendingRevokes(), ['h_old0000000000000001']);
  old.stop();
  fs.writeFileSync(path.join(dir, 'revokes.json'), JSON.stringify({ hosts: 'x' }));
  const lane = createRelayLane({ url: () => 'wss://r/v1/ws', getToken: async () => null, revokesFile: path.join(dir, 'revokes.json') });
  t.after(() => lane.stop());
  assert.deepEqual(lane.pendingRevokes(), []);
  await assert.rejects(lane.whenOpen(20), /could not be reached/);
});

test('the tunnel opens a session once the Host is on the relay, pipes its local socket, retries a failed session and lets go when released', async (t) => {
  const dir = scratch(t);
  const root = prim.randomBytes(32);
  const relay = fakeRelay();
  const lane = createRelayLane({
    url: () => 'wss://r/v1/ws',
    getToken: async () => 'tok',
    revokesFile: path.join(dir, 'rv.json'),
    createSocket: relay.createSocket,
  });
  t.after(() => lane.stop());
  // the Host's end of the session, behind the fake relay
  let hostUp = true;
  const host = createRelaySession({
    prim,
    root,
    pair: PAIR,
    role: 'host',
    send: (f) => (setImmediate(() => relay.last().say({ t: 'frame', ...f })), true),
    onStream: (s) => {
      s.onData = (b) => (s.write(b), s.consumed(b.length));
    },
  });
  const tunnel = createRelayTunnel({ lane, enrollment: { pairId: PAIR, root }, localSocket: path.join(dir, 'r.sock'), prim });
  t.after(() => tunnel.dispose());
  const states: string[] = [];
  tunnel.onState((s: string) => states.push(s));
  const lease = tunnel.acquire();
  await until(() => lane.state === 'open', 'the lane opens');
  assert.equal(tunnel.state, 'offline');
  assert.equal(tunnel.reason, 'The machine is not connected to the relay.');
  assert.equal(tunnel.available(), false);
  // frames the app sends reach the Host session while it is up
  const sock = () => relay.last();
  const forward = () => {
    for (const m of sock().sent.splice(0)) if (m.t === 'frame' && hostUp) host.handleFrame(m);
  };
  const pump = setInterval(forward, 2);
  t.after(() => clearInterval(pump));
  sock().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
  assert.equal(await lease.ready, true);
  assert.equal(tunnel.state, 'online');
  assert.equal(tunnel.available(), true);
  // a second lease is ready at once
  const second = tunnel.acquire();
  assert.equal(await second.ready, true);
  second.release();
  // a connection to the local socket is a stream of the session
  const c = net.connect(lease.socketPath);
  const got: Buffer[] = [];
  c.on('data', (d) => got.push(d as Buffer));
  c.write('round trip');
  await until(() => Buffer.concat(got).toString() === 'round trip', 'the echo');
  c.destroy();
  await until(() => tunnel.latencyMs !== null, 'latency');
  // the Host came back on a new socket (its old session is gone there): the session here goes too, and a new one opens
  sock().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
  assert.equal(tunnel.state, 'connecting');
  await until(() => tunnel.state === 'online', 'a new session after the Host reconnected');
  // the Host leaves: the session ends; it comes back but does not answer: the tunnel waits and tries again
  sock().say({ t: 'event', ev: 'peer', pair: PAIR, online: false });
  assert.equal(tunnel.state, 'offline');
  hostUp = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    sock().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
    assert.equal(tunnel.state, 'connecting');
    mock.timers.tick(10_000);
    // setTimeout is mocked here: let the rejection settle on the next turn instead
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(tunnel.state, 'offline');
    assert.match(tunnel.reason, /did not answer/);
    // while it waits, a change keeps it offline; then it tries again
    sock().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
    assert.equal(tunnel.state, 'offline');
    hostUp = true;
    mock.timers.tick(RETRY_MS);
  } finally {
    mock.timers.reset();
  }
  await until(() => tunnel.state === 'online', 'back online');
  // a connection made while no session is open is closed at once
  tunnel.fail('a bad frame');
  const refused = net.connect(lease.socketPath);
  await new Promise((r) => refused.once('close', r));
  await until(() => tunnel.state === 'online', 'a new session');
  // the lane goes down: offline with its reason
  sock().onclose({ code: 1006 });
  assert.equal(tunnel.reason, 'The relay is not connected.');
  lease.release();
  lease.release();
  tunnel.fail('nothing to fail');
  assert.equal(tunnel.state, 'offline');
  assert.equal(tunnel.leases, 0);
  const late = tunnel.acquire();
  tunnel.close();
  assert.equal(await late.ready, false);
  assert.ok(states.includes('connecting'));
});
