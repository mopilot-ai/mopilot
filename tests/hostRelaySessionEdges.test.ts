// The relay session's edges (shared/host/relaySession.mjs) against a forged peer that holds the pair root and speaks the wire by
// hand: a key of low order from either end, a reply of the wrong size, a reply the relay does not take, a record too short to read,
// a stream the app did not open, a record for no stream, a stream id opened twice, a Host that stops answering pings, a Host with no
// stream handler, and the credit edges (an exact window, a held rest larger than the credit, bytes consumed after a reset).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { fromBase64, toBase64, utf8 } from '../shared/remote/envelope.mjs';
import { PING_MS, WINDOW, createRelaySession, pipeSocket } from '../shared/host/relaySession.mjs';
import { EventEmitter } from 'node:events';

const prim = createNodePrimitives();
const c = createCrypto(prim);
const PAIR = 'p_hostpair01';
const LABEL = 'mopilot-host-session-v1';
const concat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const rec = (type: number, id: number, body = new Uint8Array(0)) => {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(body, 5);
  return out;
};
const aad = (dir: string, appNonce: Uint8Array) => utf8(`${LABEL}|${PAIR}|${dir}|${toBase64(appNonce)}`);

/** A peer that speaks the session by hand. As the Host it answers an app's open; as the app it opens to a Host. */
function forged(root: Uint8Array) {
  const openKey = c.hkdf(utf8(LABEL), root, 'open');
  const acceptKey = c.hkdf(utf8(LABEL), root, 'accept');
  const peer: any = { tx: null, rx: null };
  const keys = (sessionRoot: Uint8Array, out: 'm2p' | 'p2m') => {
    const inn = out === 'm2p' ? 'p2m' : 'm2p';
    peer.tx = c.createSender({ pair: PAIR, dir: out, chain: c.dirKey(sessionRoot, out) });
    peer.rx = c.createReceiver({ pair: PAIR, dir: inn, chain: c.dirKey(sessionRoot, inn) });
  };
  peer.seal = (plain: Uint8Array) => {
    const f = peer.tx.seal(plain);
    return { pair: PAIR, dir: f.dir, ctr: f.ctr, nonce: toBase64(f.nonce), box: toBase64(f.box) };
  };
  peer.open = (f: any) => peer.rx.open({ ...f, nonce: fromBase64(f.nonce), box: fromBase64(f.box) });
  /** The Host's answer to an app's open frame; `pk`, `half` override what it sends. */
  peer.accept = (openFrame: any, o: { pk?: Uint8Array; half?: Uint8Array } = {}) => {
    const box = fromBase64(openFrame.box);
    const appNonce = box.subarray(0, 16);
    const appPk = prim.aeadOpen(openKey, fromBase64(openFrame.nonce), box.subarray(16), aad('m2p', appNonce))!;
    const sk = prim.randomBytes(32);
    const hostNonce = prim.randomBytes(16);
    const pk = o.pk ?? prim.x25519Base(sk);
    const nonce = prim.randomBytes(24);
    const half = o.half ?? concat(pk, hostNonce);
    const reply = {
      pair: PAIR,
      dir: 'p2m',
      ctr: 0,
      nonce: toBase64(nonce),
      box: toBase64(concat(appNonce, prim.aeadSeal(acceptKey, nonce, half, aad('p2m', appNonce)))),
    };
    if (!o.pk && !o.half) keys(c.hkdf(concat(appNonce, hostNonce), concat(root, prim.x25519(sk, appPk)), `session|${PAIR}`), 'p2m');
    return reply;
  };
  /** An app's open frame (its key may be forced), and the keys once the Host's reply is read. */
  peer.hello = (o: { pk?: Uint8Array } = {}) => {
    const sk = prim.randomBytes(32);
    peer.appSk = sk;
    peer.appNonce = prim.randomBytes(16);
    const nonce = prim.randomBytes(24);
    const box = concat(peer.appNonce, prim.aeadSeal(openKey, nonce, o.pk ?? prim.x25519Base(sk), aad('m2p', peer.appNonce)));
    return { pair: PAIR, dir: 'm2p', ctr: 0, nonce: toBase64(nonce), box: toBase64(box) };
  };
  peer.readReply = (reply: any) => {
    const box = fromBase64(reply.box);
    const half = prim.aeadOpen(acceptKey, fromBase64(reply.nonce), box.subarray(16), aad('p2m', peer.appNonce))!;
    keys(
      c.hkdf(concat(peer.appNonce, half.subarray(32)), concat(root, prim.x25519(peer.appSk, half.subarray(0, 32))), `session|${PAIR}`),
      'm2p',
    );
  };
  return peer;
}

/** An app session whose frames are kept for the test to read. */
function app(root: Uint8Array, send = (_f: any) => true) {
  const sent: any[] = [];
  const s = createRelaySession({ prim, root, pair: PAIR, role: 'app', send: (f) => (sent.push(f), send(f)) });
  return { s, sent };
}

test('the app refuses a Host reply of the wrong size, and ends on a Host key of low order', async () => {
  const root = prim.randomBytes(32);
  const a = app(root);
  const host = forged(root);
  const ready = a.s.start();
  a.s.handleFrame(host.accept(a.sent[0], { half: new Uint8Array(20) }));
  assert.equal(a.s.state, 'opening', 'a reply of the wrong size is ignored');
  a.s.handleFrame(host.accept(a.sent[0], { pk: new Uint8Array(32) }));
  assert.equal(a.s.state, 'closed');
  await assert.rejects(ready, /cannot be used/);
});

test('a Host ends on an app key of low order, and on a reply the relay does not take; it serves the default stream handler', () => {
  const root = prim.randomBytes(32);
  const states: string[] = [];
  const host = createRelaySession({ prim, root, pair: PAIR, role: 'host', send: () => true, onState: (_s, why) => states.push(why) });
  const peer = forged(root);
  host.handleFrame(peer.hello({ pk: new Uint8Array(32) }));
  assert.equal(host.state, 'closed', 'no session on a key of low order');
  assert.deepEqual(states, [], 'it never opened');
  const refusing = createRelaySession({ prim, root, pair: PAIR, role: 'host', send: (f) => f.ctr !== 0 });
  refusing.handleFrame(peer.hello());
  assert.equal(refusing.state, 'closed', 'its reply did not go: no session');
  // a Host made without a stream handler takes a stream and drops it quietly; an id opened twice is reset
  const replies: any[] = [];
  const quiet = createRelaySession({ prim, root, pair: PAIR, role: 'host', send: (f) => (replies.push(f), true) });
  quiet.handleFrame(peer.hello());
  peer.readReply(replies[0]);
  quiet.handleFrame(peer.seal(rec(1, 7)));
  quiet.handleFrame(peer.seal(rec(1, 7)));
  const back = peer.open(replies.at(-1));
  assert.deepEqual([back[0], new DataView(back.buffer, back.byteOffset).getUint32(1)], [4, 7], 'the second open of id 7 is reset');
  assert.equal(quiet.streams, 1);
});

test('the app ends on a record too short to read, resets a stream the Host opened, and ignores a record for no stream', async () => {
  const root = prim.randomBytes(32);
  const a = app(root);
  const host = forged(root);
  const ready = a.s.start();
  a.s.handleFrame(host.accept(a.sent[0]));
  await ready;
  a.s.handleFrame(host.seal(rec(1, 3)));
  // the app's frames in order: the ping it sent on open, then the reset of the stream the Host tried to open
  assert.equal(host.open(a.sent[1])[0], 6);
  assert.equal(host.open(a.sent[2])[0], 4, 'the app opens streams; one the Host opened is reset');
  a.s.handleFrame(host.seal(rec(2, 99, Uint8Array.of(1))));
  assert.equal(a.s.state, 'open', 'a record for no stream changes nothing');
  a.s.handleFrame(host.seal(Uint8Array.of(2, 0)));
  assert.equal(a.s.state, 'closed');
});

test('a Host that never answers pings ends the session after two missed', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const root = prim.randomBytes(32);
    const why: string[] = [];
    const sent: any[] = [];
    const s = createRelaySession({
      prim,
      root,
      pair: PAIR,
      role: 'app',
      send: (f) => (sent.push(f), true),
      onState: (_s, w) => why.push(w),
    });
    const host = forged(root);
    const ready = s.start();
    s.handleFrame(host.accept(sent[0]));
    await ready;
    mock.timers.tick(PING_MS * 3);
    assert.equal(s.state, 'closed');
    assert.match(why.at(-1)!, /stopped answering/);
  } finally {
    mock.timers.reset();
  }
});

test('credit edges: an exact window, a rest larger than the credit that came, and bytes consumed after a reset', async () => {
  const root = prim.randomBytes(32);
  const a = app(root);
  const host = forged(root);
  const ready = a.s.start();
  a.s.handleFrame(host.accept(a.sent[0]));
  await ready;
  const st: any = a.s.openStream();
  let credits = 0;
  st.onCredit = () => credits++;
  assert.equal(st.write(new Uint8Array(WINDOW)), false, 'the window is spent exactly: wait for credit');
  // credit with nothing held: the writer hears it
  a.s.handleFrame(host.seal(rec(5, st.id, Uint8Array.of(0, 0, 0, 16))));
  assert.equal(credits, 1);
  // a rest larger than the next credit: still held, the writer does not hear yet
  assert.equal(st.write(new Uint8Array(100)), false);
  a.s.handleFrame(host.seal(rec(5, st.id, Uint8Array.of(0, 0, 0, 8))));
  assert.equal(credits, 1);
  st.reset();
  st.consumed(WINDOW);
  st.end();
  assert.equal(st.write(Uint8Array.of(1)), false);
});

test('a socket paused on a spent window resumes when the stream grants credit back', () => {
  const socket: any = Object.assign(new EventEmitter(), {
    pause: mock.fn(),
    resume: mock.fn(),
    write: () => true,
    end: () => undefined,
    destroy: () => undefined,
  });
  const stream: any = { write: mock.fn(() => false), consumed: () => undefined, end: () => undefined, reset: () => undefined };
  pipeSocket(stream, socket);
  socket.emit('data', Buffer.from('spent'));
  assert.equal(stream.write.mock.callCount(), 1);
  assert.equal(socket.pause.mock.callCount(), 1);
  stream.onCredit();
  assert.equal(socket.resume.mock.callCount(), 1);
});
