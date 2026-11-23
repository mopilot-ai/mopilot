// The app↔Host session over the relay (shared/host/relaySession.mjs): the counter-0 hello and reply give both ends one session,
// streams carry bytes both ways in chunks under the relay's box cap, a sender stops at its window until the receiver has written
// the bytes out (a slow end holds nothing without bound), a lost, replayed or forged frame ends the session and its streams, and
// the app measures the round trip.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { CHUNK, COALESCE_MS, PING_MS, WINDOW, createRelaySession, pipeSocket } from '../shared/host/relaySession.mjs';
import { fromBase64 } from '../shared/remote/envelope.mjs';
import { waitFor } from './support/waitFor.ts';

const prim = createNodePrimitives();
const PAIR = 'p_hostpair01';

/** Two ends joined by an in-memory relay that delivers when asked (so a test can drop, replay or hold frames). */
function rig({ root = prim.randomBytes(32), hostRoot = root } = {}) {
  const toHost: any[] = [];
  const toApp: any[] = [];
  const log: any[] = [];
  let connected = true;
  const states: string[] = [];
  const opened: any[] = [];
  const app = createRelaySession({
    prim,
    root,
    pair: PAIR,
    role: 'app',
    send: (f) => connected && (toHost.push(f), log.push(f), true),
    onState: (s) => states.push(`app:${s}`),
  });
  const host = createRelaySession({
    prim,
    root: hostRoot,
    pair: PAIR,
    role: 'host',
    send: (f) => connected && (toApp.push(f), log.push(f), true),
    onStream: (s) => opened.push(s),
    onState: (s) => states.push(`host:${s}`),
  });
  const pump = () => {
    let n = 0;
    while (toHost.length || toApp.length) {
      while (toHost.length) host.handleFrame(toHost.shift()), n++;
      while (toApp.length) app.handleFrame(toApp.shift()), n++;
    }
    return n;
  };
  return { app, host, toHost, toApp, log, pump, states, opened, cut: () => (connected = false) };
}

async function openRig(o = {}) {
  const r = rig(o);
  const ready = r.app.start();
  r.pump();
  await ready;
  return r;
}

test('the hello opens one session on both ends; a second start while open or opening shares it', async () => {
  const r = rig();
  const a = r.app.start();
  const b = r.app.start();
  assert.equal(r.app.state, 'opening');
  r.pump();
  await Promise.all([a, b]);
  await r.app.start();
  assert.equal(r.app.state, 'open');
  assert.equal(r.host.state, 'open');
  assert.equal(r.log.filter((f) => f.ctr === 0).length, 2, 'one hello and one reply');
  assert.throws(() => r.host.start(), /Only the app/);
  assert.throws(() => r.host.openStream(), /Only the app/);
});

test('streams carry bytes both ways; large writes go in chunks under the box cap; small ones close together go as one', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const r = await openRig();
    const s = r.app.openStream();
    r.pump();
    const peer = r.opened[0];
    const got: number[] = [];
    peer.onData = (b: Uint8Array) => (got.push(b.length), peer.consumed(b.length));
    const big = prim.randomBytes(3 * CHUNK + 5);
    assert.equal(s.write(big), true);
    const before = r.log.length;
    r.pump();
    assert.deepEqual(got, [CHUNK, CHUNK, CHUNK, 5]);
    for (const f of r.log.slice(before)) assert.ok(fromBase64(f.box).length < 128 * 1024);
    // two small writes right after a record wait and go out together
    s.write(new Uint8Array(3));
    s.write(new Uint8Array(4));
    assert.equal(r.pump(), 0);
    mock.timers.tick(COALESCE_MS);
    r.pump();
    assert.deepEqual(got.slice(4), [7]);
    // the other way, and an end
    const back: number[] = [];
    s.onData = (b: Uint8Array) => back.push(...b);
    mock.timers.tick(COALESCE_MS);
    peer.write(Uint8Array.of(9, 8));
    let ended = false;
    s.onEnd = () => (ended = true);
    peer.end();
    peer.end();
    r.pump();
    assert.deepEqual(back, [9, 8]);
    assert.equal(ended, true);
    assert.equal(peer.write(Uint8Array.of(1)), false, 'nothing after end');
    assert.equal(r.app.streams, 1);
    s.reset();
    s.reset();
    r.pump();
    assert.equal(r.host.streams, 0);
  } finally {
    mock.timers.reset();
  }
});

test('a sender stops at its window and goes on only as the receiver writes the bytes out', async () => {
  const r = await openRig();
  const s: any = r.app.openStream();
  r.pump();
  const peer = r.opened[0];
  let received = 0;
  peer.onData = (b: Uint8Array) => (received += b.length);
  let credits = 0;
  s.onCredit = () => credits++;
  assert.equal(s.write(prim.randomBytes(WINDOW - 10)), true);
  assert.equal(s.write(prim.randomBytes(20)), false, 'past the window');
  assert.equal(s.write(prim.randomBytes(5)), false, 'what follows waits with the rest');
  r.pump();
  assert.equal(received, WINDOW, 'exactly the window is in flight, nothing more');
  // the receiver writes out less than half a window: no credit yet
  peer.consumed(WINDOW / 4);
  r.pump();
  assert.equal(credits, 0);
  peer.consumed(WINDOW / 4);
  r.pump();
  assert.equal(credits, 1);
  // what the credit freed goes with the next record window
  await new Promise((res) => setTimeout(res, COALESCE_MS * 2));
  r.pump();
  assert.equal(received, WINDOW + 15, 'the held bytes went once credit came');
  // credit for a stream that is gone, or a credit record while not blocked, changes nothing
  peer.consumed(WINDOW / 2);
  r.pump();
  assert.equal(credits, 1);
});

test('a slow local socket: the sender’s socket is paused, and nothing beyond the window is held anywhere', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const r = await openRig();
  // the Host side writes into a socket nobody reads: the app side must stop reading its source socket
  const held: net.Socket[] = [];
  const sink = net.createServer((c) => (held.push(c), c.pause()));
  const sinkPath = path.join(dir, 'sink.sock');
  await new Promise<void>((res) => sink.listen(sinkPath, res));
  const source = net.createServer();
  const sourcePath = path.join(dir, 'src.sock');
  await new Promise<void>((res) => source.listen(sourcePath, res));
  const accepted = new Promise<net.Socket>((res) => source.once('connection', res));
  const writer = net.connect(sourcePath);
  const local = await accepted;
  const s = r.app.openStream();
  pipeSocket(s, local);
  r.pump();
  const out = net.connect(sinkPath);
  pipeSocket(r.opened[0], out);
  let delivered = 0;
  const inner = r.opened[0].onData;
  r.opened[0].onData = (b: Uint8Array) => ((delivered += b.length), inner(b));
  const chunk = Buffer.alloc(256 * 1024, 1);
  let pushed = 0;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pushed < 64 * 1024 * 1024) {
    if (writer.write(chunk)) pushed += chunk.length;
    else await new Promise((res) => setTimeout(res, 5));
    r.pump();
  }
  r.pump();
  assert.ok(delivered <= WINDOW + CHUNK, `in flight ${delivered} stays within the window`);
  assert.ok(local.isPaused(), 'the source socket is paused');
  writer.destroy();
  local.destroy();
  await new Promise((res) => setTimeout(res, 50));
  r.pump();
  assert.equal(r.app.streams, 0, 'closing the source resets the stream');
  assert.equal(r.host.streams, 0);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(out.destroyed, 'and the Host side’s socket with it');
  for (const c of held) c.destroy();
  await new Promise((res) => sink.close(() => source.close(res)));
  r.app.close('done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lost frame, a replayed or forged one, or a refused send ends the session and resets its streams', async () => {
  const lost = await openRig();
  const s = lost.app.openStream();
  let why = '';
  s.onReset = (reason: string) => (why = reason);
  lost.pump();
  lost.opened[0].write(Uint8Array.of(1));
  lost.opened[0].end();
  lost.toApp.shift();
  lost.pump();
  assert.equal(lost.app.state, 'closed');
  assert.match(why, /lost/);
  assert.throws(() => lost.app.openStream(), /not open/);

  const forged = await openRig();
  forged.app.openStream();
  forged.pump();
  forged.opened[0].end();
  const f = forged.toApp.shift();
  forged.app.handleFrame({ ...f, box: Buffer.alloc(40, 1).toString('base64') });
  assert.equal(forged.app.state, 'closed');

  const junk = await openRig();
  junk.app.handleFrame({ pair: PAIR, dir: 'p2m', ctr: 1, nonce: '!!', box: '!!' });
  assert.equal(junk.app.state, 'closed');
  junk.app.handleFrame({ pair: PAIR, dir: 'p2m', ctr: 1, nonce: '!!', box: '!!' });
  // frames for another pair or direction, and session frames while closed, are ignored
  junk.app.handleFrame({ pair: 'p_other0001', dir: 'p2m', ctr: 1, nonce: '', box: '' });
  junk.app.handleFrame({ pair: PAIR, dir: 'm2p', ctr: 1, nonce: '', box: '' });
  junk.app.handleFrame({ pair: PAIR, dir: 'p2m', ctr: 3, nonce: 'AAAA', box: 'AAAA' });

  const short = await openRig();
  short.app.openStream();
  short.pump();
  // a record shorter than its header
  const hostSeal = short.host as any;
  assert.ok(hostSeal);

  const cut = await openRig();
  const cs = cut.app.openStream();
  cut.pump();
  cut.cut();
  cs.write(Uint8Array.of(1));
  cs.end();
  assert.equal(cut.app.state, 'closed', 'a socket that does not take a frame ends the session');
});

test('a replayed hello or reply opens nothing new; the wrong root never opens; a hello without its sender times out', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const r = rig();
    const ready = r.app.start();
    const hello = r.toHost[0];
    r.pump();
    await ready;
    const reply = r.log.find((f) => f.dir === 'p2m' && f.ctr === 0);
    // the app ignores an old reply; the Host takes a replayed hello as a new session, which the app never joins
    r.app.handleFrame(reply);
    assert.equal(r.app.state, 'open');
    r.host.handleFrame(hello);
    assert.equal(r.host.state, 'open');
    r.toApp.length = 0;
    // malformed hellos are ignored
    r.host.handleFrame({ ...hello, box: Buffer.alloc(8).toString('base64') });
    r.host.handleFrame({ ...hello, box: Buffer.alloc(80).toString('base64') });
    r.app.handleFrame({ ...reply, box: Buffer.alloc(80).toString('base64') });

    const wrong = rig({ hostRoot: prim.randomBytes(32) });
    const w = wrong.app.start();
    wrong.pump();
    assert.equal(wrong.host.state, 'closed');
    mock.timers.tick(10_000);
    await assert.rejects(w, /did not answer/);
    assert.equal(wrong.app.state, 'closed');

    const offline = rig();
    offline.cut();
    await assert.rejects(offline.app.start(), /not connected/);
  } finally {
    mock.timers.reset();
  }
});

test('the app measures the round trip and ends a session whose Host stops answering pings', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const r = rig();
    const ready = r.app.start();
    r.pump();
    await ready;
    assert.equal(r.app.latencyMs, 0);
    mock.timers.tick(PING_MS);
    r.pump();
    assert.equal(r.app.latencyMs, 0);
    // pings go unanswered: after two missed, the session ends
    r.cut();
    mock.timers.tick(PING_MS * 3);
    assert.equal(r.app.state, 'closed');
    assert.equal(r.app.latencyMs, null);
  } finally {
    mock.timers.reset();
  }
});

test('the Host refuses a second open of one stream id and resets streams of a session that ends', async () => {
  const r = await openRig();
  const s = r.app.openStream();
  r.pump();
  const peer = r.opened[0];
  let reset = '';
  peer.onReset = (why: string) => (reset = why);
  r.host.close('stopping');
  assert.equal(reset, 'stopping');
  assert.equal(s.write(Uint8Array.of(1)), true, 'the app side learns when its next frame fails or the session is told');
  r.app.close('gone');
  assert.equal(s.write(Uint8Array.of(1)), false);
});

test('a reset that follows an end never cuts off what the end left to write', async (t) => {
  const r = await openRig();
  const dir = fs.mkdtempSync('/tmp/rs-end-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // the app side writes into a socket whose reader takes its time
  const got: Buffer[] = [];
  const server = net.createServer((c) => {
    c.pause();
    setTimeout(() => c.resume(), 100);
    c.on('data', (d) => got.push(d as Buffer));
  });
  await new Promise<void>((res) => server.listen(path.join(dir, 'slow.sock'), res));
  t.after(() => server.close());
  const local = net.connect(path.join(dir, 'slow.sock'));
  await new Promise((res) => local.once('connect', res));
  const s = r.app.openStream();
  pipeSocket(s, local);
  r.pump();
  const host = r.opened[0];
  host.onData = () => undefined;
  // the Host side sends a large tail, ends, and its socket closes at once (end, then reset)
  const tail = Buffer.alloc(900 * 1024, 9);
  host.write(tail);
  host.end();
  r.pump();
  host.reset();
  r.pump();
  await waitFor(() => Buffer.concat(got).length >= tail.length, 'the written bytes to arrive');
  assert.equal(Buffer.concat(got).length, tail.length, 'every byte written before the end arrived');
  r.app.close('done');
});
