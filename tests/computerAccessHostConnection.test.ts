// Computer access (#1364): the host's end of a connection over a fake socket, for what a real peer rarely does: a hello
// that isn't JSON, a message while pairing, a frame replayed or of an unknown type, a device revoked mid-handshake and
// a handshake that stalls. Each ends the connection with a code the device reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostConnection, CLOSE, closeWhy } = require('../electron/computerAccess/hostConnection.cjs');
const hs = require('../electron/computerAccess/handshake.cjs');
const { SecureChannel } = require('../electron/computerAccess/frames.cjs');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** The host's side of a socket: what it sent, how it closed, and a way to send it text. */
function fakeWs() {
  const ws: any = new EventEmitter();
  ws.sent = [];
  ws.closed = null;
  ws.send = (t: string) => (ws.sent.push(t), true);
  ws.close = (code: number, reason: string) => {
    ws.closed = { code, reason };
  };
  ws.recv = (t: string) => ws.emit('message', t);
  return ws;
}

/** A host connection with a paired device `client` (or none), and that device's handshake run up to the open state. */
function hostSide(o: { known?: (k: string) => boolean; pairSecret?: () => string | null; handshakeMs?: number } = {}) {
  const host = hs.newKeyPair();
  const client = hs.newKeyPair();
  const ws = fakeWs();
  const conn = new HostConnection({
    ws,
    identity: () => host,
    known: o.known ?? ((k: string) => k === client.x),
    pairSecret: o.pairSecret ?? (() => null),
    handshakeMs: o.handshakeMs ?? 1000,
  });
  const events: any[] = [];
  for (const ev of ['pair', 'open', 'request', 'close']) conn.on(ev, (...a: any[]) => events.push([ev, ...a]));
  /** Runs the device's side of the handshake; returns its channel. */
  const handshake = (pair: any = null) => {
    const c1 = hs.clientHello({ identity: client, pair });
    ws.recv(JSON.stringify(c1.message));
    const welcome = JSON.parse(ws.sent.at(-1));
    const done = hs.clientFinish({ state: c1.state, welcome, hostKey: host.x, fingerprint: pair ? hs.fingerprint(host.x) : null });
    ws.recv(JSON.stringify(done.message));
    return new SecureChannel(done.session);
  };
  return { host, client, ws, conn, events, handshake };
}

test('host connection: a paired device opens and its requests come through; ping is answered here', () => {
  const h = hostSide();
  const ch = h.handshake();
  assert.equal(h.conn.open, true);
  assert.deepEqual(h.events[0], ['open', h.client.x]);
  h.ws.recv(ch.seal({ t: 'tools' }));
  assert.deepEqual(h.events.at(-1), ['request', { t: 'tools' }]);
  const before = h.ws.sent.length;
  h.ws.recv(ch.seal({ t: 'ping' }));
  // the pong is the one frame sent back, and no request was raised for it
  assert.equal(h.ws.sent.length, before + 1);
  assert.equal(h.events.filter((e: any) => e[0] === 'request').length, 1);
  // admit only applies to a connection that is pairing
  assert.equal(h.conn.admit('x'), false);
});

test('host connection: each way a device can misbehave ends the connection with a code it reads', () => {
  const cases: [string, (h: any) => void, number][] = [
    ['hello not JSON', (h) => h.ws.recv('{'), CLOSE.protocol],
    ['unknown device', (h) => h.ws.recv(JSON.stringify(hs.clientHello({ identity: hs.newKeyPair() }).message)), CLOSE.unknown_device],
    [
      'pairing with no offer',
      (h) => h.ws.recv(JSON.stringify(hs.clientHello({ identity: hs.newKeyPair(), pair: { name: 'x', secret: 's' } }).message)),
      CLOSE.no_pairing,
    ],
    [
      'a confirmation that proves nothing',
      (h) => {
        h.ws.recv(JSON.stringify(hs.clientHello({ identity: h.client }).message));
        h.ws.recv(JSON.stringify({ t: 'confirm', mac: '0'.repeat(64) }));
      },
      CLOSE.unauthorized,
    ],
    [
      'a frame replayed',
      (h) => {
        const ch = h.handshake();
        const f = ch.seal({ t: 'tools' });
        h.ws.recv(f);
        h.ws.recv(f);
      },
      CLOSE.unauthorized,
    ],
    ['an unknown request', (h) => h.ws.recv(h.handshake().seal({ t: 'exec', cmd: 'rm -rf' })), CLOSE.protocol],
    ['a request that is no object', (h) => h.ws.recv(h.handshake().seal(null)), CLOSE.protocol],
    ['a frame that is not one', (h) => (h.handshake(), h.ws.recv('!!')), CLOSE.protocol],
  ];
  for (const [what, run, code] of cases) {
    const h = hostSide();
    run(h);
    assert.equal(h.ws.closed?.code, code, what);
    assert.equal(h.events.at(-1)[0], 'close', what);
  }
});

test('host connection: revoked between hello and confirmation, a message while pairing, and a handshake that stalls', async () => {
  let paired = true;
  const a = hostSide({ known: () => paired });
  const c1 = hs.clientHello({ identity: a.client });
  a.ws.recv(JSON.stringify(c1.message));
  const done = hs.clientFinish({ state: c1.state, welcome: JSON.parse(a.ws.sent[0]), hostKey: a.host.x });
  paired = false;
  a.ws.recv(JSON.stringify(done.message));
  assert.equal(a.ws.closed.code, CLOSE.unknown_device);

  const b = hostSide({ pairSecret: () => 'S'.repeat(43) });
  const ch = b.handshake({ name: 'Phone', secret: 'S'.repeat(43) });
  assert.equal(b.events[0][0], 'pair');
  assert.equal(b.events[0][1].name, 'Phone');
  b.ws.recv(ch.seal({ t: 'tools' }));
  assert.equal(b.ws.closed.code, CLOSE.protocol);
  // once closed, nothing is sent and a second close does nothing
  assert.equal(b.conn.send({ t: 'x' }), false);
  b.conn.close('off', 'again');
  assert.equal(b.ws.closed.code, CLOSE.protocol);
  // a message after the close is ignored
  b.ws.recv('anything');

  // the default wait is long; a connection made with it is closed here
  const dflt = new HostConnection({ ws: fakeWs(), identity: () => hs.newKeyPair(), known: () => false, pairSecret: () => null });
  dflt.close('off', 'test');
  const c = hostSide({ handshakeMs: 10 });
  await tick(30);
  assert.equal(c.ws.closed.code, CLOSE.timeout);
  // the socket going away on its own ends the connection once
  const d = hostSide();
  d.ws.emit('close', 1006, 'lost');
  d.ws.emit('close', 1006, 'lost');
  assert.deepEqual(
    d.events.filter((e: any) => e[0] === 'close'),
    [['close', 1006, 'lost']],
  );
  // a send that fails on the socket is reported, not thrown
  const e = hostSide();
  e.handshake();
  e.ws.send = () => {
    throw new Error('socket gone');
  };
  assert.equal(e.conn.send({ t: 'result' }), false);
  // a close for a reason without a code of its own uses the protocol code
  const f = hostSide();
  f.conn.close('nonsense', 'x');
  assert.equal(f.ws.closed.code, CLOSE.protocol);
  assert.equal(f.conn.send({ t: 'x' }), false);
});

test('closeWhy maps a handshake error, a replayed frame and anything else', () => {
  assert.equal(closeWhy(new hs.HandshakeError('no_pairing', 'x')), 'no_pairing');
  assert.equal(closeWhy(new hs.HandshakeError('wrong_host', 'x')), 'protocol');
  assert.equal(closeWhy({ code: 'replay' }), 'unauthorized');
  assert.equal(closeWhy({ code: 'unauthorized' }), 'unauthorized');
  assert.equal(closeWhy(new SyntaxError('json')), 'protocol');
  assert.equal(closeWhy(null), 'protocol');
});
