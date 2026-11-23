// relay/src/hub.mjs under load: a burst bigger than the old 200-message cap is slowed down (the socket is paused) rather than cut off, a slow receiver never holds up a sender, a stuck or backed-up socket is dropped with its frames kept, and a shutdown finishes what it started.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeHub, settle, FakeSocket, P, frame, paired as pairedOn } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
await migrateDurable(db);
beforeEach(reset);
const pairedDurable = (o: Parameters<typeof makeHub>[1] = {}) => pairedOn(db, { ...o, durable: true });

/** A socket that can be paused and resumed like a ws WebSocket, reports its buffered bytes, and can hold back its send callbacks. */
class FlowSocket extends FakeSocket {
  paused = 0;
  resumed = 0;
  bufferedAmount = 0;
  hold = false;
  held: (() => void)[] = [];
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  override send(text: string, cb: (err?: Error | null) => void) {
    if (!this.hold) return super.send(text, cb);
    this.sent.push(JSON.parse(text));
    this.held.push(() => cb(null));
  }
  release() {
    this.hold = false;
    for (const cb of this.held.splice(0)) cb();
  }
}

const until = async (done: () => boolean) => {
  await waitFor(done, 'the condition');
  assert.ok(done(), 'condition not reached');
};

async function pairedWith(macSocket: FlowSocket, phoneSocket: FlowSocket, o: Parameters<typeof makeHub>[1] = {}) {
  const r = makeHub(db, { ...o, durable: true });
  const mac = await r.join('u1', 'mac1', 'desktop', undefined, macSocket);
  const phone = await r.join('u1', 'ph1', 'phone', undefined, phoneSocket);
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  macSocket.sent.length = 0;
  phoneSocket.sent.length = 0;
  return { ...r, mac, phone };
}

test('a burst of more than 200 frames is stored and acked in order, not cut off', async () => {
  const r = await pairedDurable({ mailbox: { ttlMs: 7 * 24 * 3600_000, maxFrames: 1000, maxBytes: 64 * 1024 * 1024 } });
  for (let i = 1; i <= 260; i++) r.mac.h.message(JSON.stringify(frame('m2p', i)));
  await settle(r.hub);
  assert.equal(r.mac.socket.closedWith, null);
  const acks = r.mac.socket.of('ack').filter((a) => a.via === 'mailbox');
  assert.equal(acks.length, 260);
  assert.deepEqual(
    r.phone.socket.of('frame').map((f) => f.ctr),
    Array.from({ length: 260 }, (_, i) => i + 1),
  );
});

test('a connection with a backlog is paused and resumed once it catches up', async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket());
  for (let i = 0; i < 80; i++) r.mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.ok(mac.paused >= 1, 'the socket stopped reading while 80 messages waited');
  assert.equal(mac.resumed, 0);
  await settle(r.hub);
  assert.equal(mac.resumed, mac.paused, 'every pause is followed by a resume');
  assert.equal(mac.closedWith, null);
});

test('a connection past the hard cap is cut off even though it ignored the pause', async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket(), {
    limits: { pendingHigh: 4, pendingLow: 2, pendingMax: 10, pendingBytesMax: 1 << 20 },
  });
  for (let i = 0; i < 12; i++) r.mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.deepEqual(mac.closedWith, { code: 1008, reason: 'too many pending messages' });
  await settle(r.hub);
});

test('a connection whose queued bytes pass the byte cap is cut off', async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket(), { limits: { pendingHigh: 4, pendingLow: 2, pendingMax: 1000, pendingBytesMax: 2000 } });
  const big = JSON.stringify({ t: 'presence', state: 'online', pad: 'x'.repeat(900) });
  for (let i = 0; i < 4; i++) r.mac.h.message(big);
  assert.deepEqual(mac.closedWith, { code: 1008, reason: 'too many pending messages' });
  await settle(r.hub);
});

test('a receiver that never finishes reading does not hold up its sender: acks keep coming and the frames stay stored for it', async () => {
  const phone = new FlowSocket();
  const r = await pairedWith(new FlowSocket(), phone);
  phone.hold = true;
  for (const ctr of [1, 2, 3]) r.mac.h.message(JSON.stringify(frame('m2p', ctr)));
  await until(() => r.mac.socket.of('ack').length === 3);
  assert.deepEqual(
    r.mac.socket.of('ack').map((a) => a.ctr),
    [1, 2, 3],
  );
  phone.release();
  await settle(r.hub);
  assert.deepEqual(
    phone.of('frame').map((f) => f.ctr),
    [1, 2, 3],
  );
});

test('a socket with too many unsent bytes is dropped as a slow consumer and its frames wait for the next connection', async () => {
  const phone = new FlowSocket();
  const r = await pairedWith(new FlowSocket(), phone, { limits: { slowConsumerBytes: 1000 } });
  phone.bufferedAmount = 5000;
  await r.mac.say({ ...frame('m2p', 1) });
  await settle(r.hub);
  assert.deepEqual(phone.closedWith, { code: 1013, reason: 'slow consumer' });
  assert.equal(phone.of('frame').length, 0);
  assert.deepEqual(
    r.mac.socket.of('ack').map((a) => a.ctr),
    [1],
  );
  const back = await r.join('u1', 'ph1', 'phone');
  await settle(r.hub);
  assert.deepEqual(
    back.socket.of('frame').map((f) => f.ctr),
    [1],
  );
});

test('a send that never completes is given up on after the send timeout, the socket dropped and its frames kept', async () => {
  const phone = new FlowSocket();
  const r = await pairedWith(new FlowSocket(), phone, { limits: { sendTimeoutMs: 30 } });
  phone.hold = true;
  r.mac.h.message(JSON.stringify(frame('m2p', 1)));
  await until(() => phone.closedWith !== null);
  assert.deepEqual(phone.closedWith, { code: 1013, reason: 'slow consumer' });
  // the send finishes after it was given up on: nothing happens twice, and a second slow report on a dropped socket is ignored
  phone.release();
  const dropped = r.hub.conns.get('ph1')!;
  assert.equal(dropped.closed, true);
  r.hub.dropSlow(dropped);
  assert.equal(phone.closedWith?.code, 1013);
  const back = await r.join('u1', 'ph1', 'phone');
  await settle(r.hub);
  assert.deepEqual(
    back.socket.of('frame').map((f) => f.ctr),
    [1],
  );
});

test('shutdown finishes the message in flight, answers it, then closes every socket with 1012 and ignores later messages', async () => {
  const r = await pairedDurable();
  r.mac.h.message(JSON.stringify({ ...frame('m2p', 1) }));
  const down = r.hub.shutdown({ graceMs: 5000 });
  r.mac.h.message(JSON.stringify({ ...frame('m2p', 2) }));
  await down;
  assert.deepEqual(r.mac.socket.closedWith, { code: 1012, reason: 'restarting' });
  assert.deepEqual(r.phone.socket.closedWith, { code: 1012, reason: 'restarting' });
  const order = r.mac.socket.sent.map((m) => `${m.t}:${m.ctr}`);
  assert.deepEqual(order, ['ack:1']);
  const stored = await db.query('SELECT ctr FROM remote_durable.frames ORDER BY ctr');
  assert.deepEqual(
    stored.rows.map((x: any) => Number(x.ctr)),
    [1],
  );
  assert.equal(r.hub.conns.size, 0);
  assert.equal(r.hub.draining, true);
  const late = new FlowSocket();
  r.hub.connect(late as any, { userId: 'u1', deviceId: 'mac1', kind: 'desktop', expMs: r.clock.t + 1000 });
  await settle(r.hub);
  assert.deepEqual(late.closedWith, { code: 1012, reason: 'restarting' });
});

test('shutdown gives up on a connection that does not finish within the grace period', async () => {
  const phone = new FlowSocket();
  const r = await pairedWith(new FlowSocket(), phone);
  const conn = r.hub.conns.get('mac1')!;
  conn.queue = new Promise(() => undefined);
  await r.hub.shutdown({ graceMs: 30 });
  assert.deepEqual(r.mac.socket.closedWith, { code: 1012, reason: 'restarting' });
  assert.deepEqual(phone.closedWith, { code: 1012, reason: 'restarting' });
});

test('a close that arrives while the connection is at its hard cap is still handled, and the counts stay balanced', async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket(), { limits: { pendingHigh: 4, pendingLow: 2, pendingMax: 6, pendingBytesMax: 1 << 20 } });
  const conn = r.hub.conns.get('mac1')!;
  for (let i = 0; i < 7; i++) r.mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.equal(mac.closedWith?.code, 1008);
  r.mac.h.close(1006);
  await settle(r.hub);
  assert.deepEqual({ pending: conn.pending, receipts: conn.receipts, bytes: conn.bytes }, { pending: 0, receipts: 0, bytes: 0 });
});

test('a paused socket is not judged by its pongs, and any message it does send shows it is alive', async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket());
  const conn = r.hub.conns.get('mac1')!;
  conn.missed = 2;
  r.mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.equal(conn.missed, 0, 'a message resets the count');
  conn.missed = 3;
  conn.paused = true;
  r.hub.tick();
  assert.equal(mac.terminated, false, 'three missed pings do not end a socket the relay is not reading');
  assert.equal(conn.missed, 0);
  conn.paused = false;
  conn.missed = 3;
  r.hub.tick();
  assert.equal(mac.terminated, true);
  await settle(r.hub);
});

test("closing a paused socket resumes it first so the other side's answer to the close is read", async () => {
  const mac = new FlowSocket();
  const r = await pairedWith(mac, new FlowSocket(), {
    limits: { pendingHigh: 2, pendingLow: 1, pendingMax: 50, pendingBytesMax: 1 << 20 },
  });
  for (let i = 0; i < 4; i++) r.mac.h.message(JSON.stringify({ t: 'presence', state: 'online' }));
  assert.ok(mac.paused >= 1);
  const resumedBefore = mac.resumed;
  r.hub.drop(r.hub.conns.get('mac1')!, 4000, 'replaced');
  assert.equal(mac.resumed, resumedBefore + 1);
  assert.deepEqual(mac.closedWith, { code: 4000, reason: 'replaced' });
  await settle(r.hub);
});

test('shutdown closes a connection that was still starting and waits for a delivery that a finishing handler began', async () => {
  const phone = new FlowSocket();
  const r = await pairedWith(new FlowSocket(), phone);
  // a third connection is part-way through start() (waiting on the database) when the shutdown begins
  const store = r.store;
  const isRevoked = store.isRevoked.bind(store);
  let letStart: (() => void) | undefined;
  store.isRevoked = async (id: string) => {
    if (id === 'late1') await new Promise<void>((resolve) => (letStart = resolve));
    return isRevoked(id);
  };
  const late = new FlowSocket();
  r.hub.connect(late as any, { userId: 'u1', deviceId: 'late1', kind: 'desktop', expMs: r.clock.t + 1000 });
  await waitFor(() => letStart !== undefined, 'the late connection waiting in its startup read');
  assert.equal(r.hub.conns.has('late1'), false);
  const down = r.hub.shutdown({ graceMs: 2000 });
  letStart!();
  await down;
  assert.deepEqual(late.closedWith, { code: 1012, reason: 'restarting' });
  assert.equal(r.hub.conns.has('late1'), false, 'it never registered');
  assert.deepEqual(phone.closedWith, { code: 1012, reason: 'restarting' });
  // a delivery started by a handler that was finishing is waited for: the frame reaches the phone before it is closed
  const r2 = await pairedWith(new FlowSocket(), new FlowSocket());
  r2.mac.h.message(JSON.stringify(frame('m2p', 1)));
  await r2.hub.shutdown({ graceMs: 2000 });
  assert.deepEqual(
    r2.phone.socket.of('frame').map((f) => f.ctr),
    [1],
  );
});

test('shutdown waits for the database work of a Mac that closed just before it, so the pool is not ended under it', async () => {
  const r = await pairedWith(new FlowSocket(), new FlowSocket());
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  const phonesOfMac = r.store.phonesOfMac.bind(r.store);
  let release = () => {};
  let reached = false;
  r.store.phonesOfMac = async (id: string) => {
    reached = true;
    await new Promise<void>((resolve) => (release = resolve));
    return phonesOfMac(id);
  };
  r.mac.h.close(1006);
  await waitFor(() => reached, 'the close to be reached');
  assert.equal(reached, true);
  let done = false;
  const down = r.hub.shutdown({ graceMs: 3000 }).then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, 'the shutdown is still waiting for the close to finish');
  release();
  await down;
  assert.equal(done, true);
});
