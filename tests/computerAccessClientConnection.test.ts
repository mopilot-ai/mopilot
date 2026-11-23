// Computer access (#1364): a client's end of a connection over a fake socket: results find their own call, pushes nobody
// waits for are ignored, a close fails every waiting call, a computer that never answers or answers with the wrong key
// is refused, and pairing waits for the person on the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClientConnection, closeText } = require('../electron/computerAccess/clientConnection.cjs');
const hs = require('../electron/computerAccess/handshake.cjs');
const { SecureChannel } = require('../electron/computerAccess/frames.cjs');

/** A WebSocket stand-in for the client: the test plays the computer. */
function fakeSocketClass() {
  const sockets: any[] = [];
  class FakeSocket extends EventEmitter {
    url: string;
    sent: string[] = [];
    closed: any = null;
    constructor(url: string) {
      super();
      this.url = url;
      sockets.push(this);
    }
    addEventListener(ev: string, fn: any) {
      this.on(ev, fn);
    }
    send(t: string) {
      this.sent.push(t);
    }
    close(code: number, reason: string) {
      this.closed = { code, reason };
    }
  }
  return { FakeSocket, sockets };
}

/** A client connected to a fake computer that answers its hello; returns the computer's channel to it. */
async function clientSide(o: any = {}) {
  const { FakeSocket, sockets } = fakeSocketClass();
  const host = hs.newKeyPair();
  const identity = hs.newKeyPair();
  const c = new ClientConnection({ url: 'ws://x', identity, hostKey: host.x, WebSocket: FakeSocket, handshakeMs: 200, ...o });
  const p = c.connect();
  const s = sockets[0];
  s.emit('open');
  const h1 = hs.hostRespond({ identity: host, hello: JSON.parse(s.sent[0]), known: () => true, pairSecret: () => null });
  s.emit('message', { data: JSON.stringify(h1.message) });
  await p;
  const done = hs.hostFinish({ state: h1.state, confirm: JSON.parse(s.sent[1]) });
  return { c, s, ch: new SecureChannel(done.session) };
}

test('client connection: results find their call, pushes nobody waits for are ignored, and an unknown push ends it', async () => {
  const { c, s, ch } = await clientSide();
  const call = c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
  // the computer reads the call with its side of the keys
  const m = ch.open(s.sent.at(-1));
  assert.equal(m.t, 'call');
  s.emit('message', { data: ch.seal({ t: 'result', callId: 'not-mine', ok: true }) });
  s.emit('message', { data: ch.seal({ t: 'result', callId: m.callId, ok: true, content: 'x' }) });
  assert.deepEqual(await call, { ok: true, content: [], error: null });
  // a refusal with no words still says it failed
  const refused = c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
  const m2 = ch.open(s.sent.at(-1));
  s.emit('message', { data: ch.seal({ t: 'result', callId: m2.callId, ok: false }) });
  assert.deepEqual(await refused, { ok: false, content: [], error: { code: 'failed', message: 'The computer refused the call' } });
  const tools = c.tools();
  s.emit('message', { data: ch.seal({ t: 'tools', tools: 'nope' }) });
  assert.deepEqual(await tools, []);
  const stopped = new Promise((r) => c.once('stop', r));
  s.emit('message', { data: ch.seal({ t: 'stop', chat: 'c' }) });
  assert.deepEqual(await stopped, { t: 'stop', chat: 'c' });
  assert.equal(c.turnEnded('c'), true);
  assert.equal(c.answer('id', null), true);
  // paired() on a connection that is already open is refused
  await assert.rejects(c.paired(), /not pairing/);
  const closed = new Promise((r) => c.once('close', (code: number) => r(code)));
  s.emit('message', { data: ch.seal({ t: 'exec' }) });
  assert.equal(await closed, 4400);
  await assert.rejects(c.call({ chat: 'c', turn: 't', tool: 'x' }), /Not connected/);
  await assert.rejects(c.tools(), /Not connected/);
  assert.equal(c.send({ t: 'x' }), false);
  // a second close does nothing
  c.close();
});

test('client connection: a close fails every waiting call and tool list; a call that never ends times out', async () => {
  const { c, s, ch } = await clientSide({ callMs: 20 });
  await assert.rejects(c.call({ chat: 'c', turn: 't', tool: 'x' }), /didn't finish the call in time/);
  const waiting = c.call({ chat: 'c', turn: 't', tool: 'x' });
  const tools = c.tools();
  s.emit('close', { code: 4503, reason: '' });
  await assert.rejects(waiting, /Computer access is off on that computer/);
  assert.deepEqual(await tools, []);
  assert.equal(c.phase, 'closed');
  assert.ok(ch);
});

test('client connection: a computer that never answers, a welcome from the wrong key, and a socket that closes first', async () => {
  const { FakeSocket, sockets } = fakeSocketClass();
  const slow = new ClientConnection({
    url: 'ws://x',
    identity: hs.newKeyPair(),
    hostKey: hs.newKeyPair().x,
    WebSocket: FakeSocket,
    handshakeMs: 10,
  });
  await assert.rejects(slow.connect(), /didn't answer in time/);
  assert.equal(slow.phase, 'closed');

  const wrong = new ClientConnection({ url: 'ws://x', identity: hs.newKeyPair(), hostKey: hs.newKeyPair().x, WebSocket: FakeSocket });
  const p = wrong.connect();
  const s = sockets.at(-1);
  s.emit('open');
  const h1 = hs.hostRespond({ identity: hs.newKeyPair(), hello: JSON.parse(s.sent[0]), known: () => true, pairSecret: () => null });
  s.emit('message', { data: JSON.stringify(h1.message) });
  await assert.rejects(p, /not the one paired/);
  assert.equal(s.closed.code, 4400);

  const early = new ClientConnection({ url: 'ws://x', identity: hs.newKeyPair(), hostKey: 'k', WebSocket: FakeSocket });
  const q = early.connect();
  sockets.at(-1).emit('error', new Error('refused'));
  sockets.at(-1).emit('close', { code: 1006, reason: '' });
  await assert.rejects(q, /closed \(1006\)/);
  // closing a socket that throws is still a close here
  const bad = new ClientConnection({ url: 'ws://x', identity: hs.newKeyPair(), WebSocket: FakeSocket });
  bad.ws = {
    close: () => {
      throw new Error('already closed');
    },
  };
  bad.close();
  assert.equal(bad.phase, 'closed');
  // a send whose socket throws reports false
  const { c, s: s2 } = await clientSide();
  s2.send = () => {
    throw new Error('gone');
  };
  assert.equal(c.send({ t: 'ping' }), false);
});

test('client connection: pairing waits for the person, and a close while waiting fails it', async () => {
  const { FakeSocket, sockets } = fakeSocketClass();
  const host = hs.newKeyPair();
  const secret = 'S'.repeat(43);
  const mk = () =>
    new ClientConnection({
      url: 'ws://x',
      identity: hs.newKeyPair(),
      pair: { name: 'Phone', secret, fingerprint: hs.fingerprint(host.x) },
      WebSocket: FakeSocket,
    });
  const run = async (c: any) => {
    const p = c.connect();
    const s = sockets.at(-1);
    s.emit('open');
    const h1 = hs.hostRespond({ identity: host, hello: JSON.parse(s.sent[0]), known: () => false, pairSecret: () => secret });
    s.emit('message', { data: JSON.stringify(h1.message) });
    const r = await p;
    const done = hs.hostFinish({ state: h1.state, confirm: JSON.parse(s.sent[1]) });
    return { r, s, ch: new SecureChannel(done.session) };
  };
  const a = mk();
  const { r, s, ch } = await run(a);
  assert.match(r.code, /^\d{3} \d{3}$/);
  assert.equal(a.open, false);
  const paired = a.paired();
  s.emit('message', { data: ch.seal({ t: 'paired', host: 'Studio', device: 'd1' }) });
  assert.deepEqual(await paired, { host: 'Studio', device: 'd1' });
  assert.equal(a.open, true);
  const b = mk();
  const rb = await run(b);
  const waiting = b.paired();
  const denied = new Promise((res) => b.once('denied', res));
  rb.s.emit('message', { data: rb.ch.seal({ t: 'denied' }) });
  await denied;
  rb.s.emit('close', { code: 4401, reason: '' });
  await assert.rejects(waiting, /didn't accept this device's key/);
});

test('closeText names each close code a computer sends, and falls back to the reason or the code', () => {
  for (const code of [4401, 4403, 4404, 4408, 4410, 4503]) assert.ok(closeText(code, '').length > 10);
  assert.equal(closeText(1000, 'bye'), 'bye');
  assert.equal(closeText(1006, ''), 'The connection to the computer closed (1006)');
});
