// The relay hub with the durable mailbox (relay/src/hub.mjs + durableMailbox.mjs) over PGlite: a counted frame stays stored until its receiver acks it, is redelivered in order on reconnect, expires after the TTL with a drop notice, and replays are idempotent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, makeHub, settle, P, frame, b64, MAILBOX, pairedDurable } from './support/relayKit.ts';

const require = createRequire(import.meta.url);
const { migrateDurable } = require('../relay/src/durableStore.mjs');
const { db, reset } = await makeDb();
await migrateDurable(db);
beforeEach(reset);

const ctrs = (socket: any) => socket.of('frame').map((f: any) => f.ctr);
const ack = (dir: 'm2p' | 'p2m', ctr: number, pair = P) => ({ t: 'ack', pair, dir, ctr });
/** Reconnects a device as a fresh socket, the way a dropped connection does. */
const reconnect = async (r: any, id: string, kind: 'desktop' | 'phone') => r.join('u1', id, kind);

test('hello says the relay keeps frames until acked; a relay without the durable store does not', async () => {
  const on = await pairedDurable(db);
  const ph = await reconnect(on, 'ph1', 'phone');
  assert.equal(ph.socket.of('hello')[0].acks, true);
  const off = makeHub(db);
  const mac = await off.join('u1', 'mac1', 'desktop');
  assert.equal('acks' in mac.socket.of('hello')[0], false);
  await mac.say(ack('p2m', 1));
  assert.equal(mac.socket.last().code, 'bad_message');
});

test('a frame for an offline peer is stored, acked to the sender, and redelivered on every connect until the peer acks it', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 2));
  assert.deepEqual(
    r.mac.socket.of('ack').map((a: any) => [a.ctr, a.via]),
    [
      [1, 'mailbox'],
      [2, 'mailbox'],
    ],
  );
  const first = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(first.socket), [1, 2]);
  // it dies before acking anything: the next connection gets both again, in order
  const second = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(second.socket), [1, 2]);
  await second.say(ack('m2p', 1));
  const third = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(third.socket), [2]);
  await third.say(ack('m2p', 2));
  await third.say(ack('m2p', 2));
  assert.equal(third.socket.of('error').length, 0, 'a repeated ack is harmless');
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), []);
});

test('a live peer gets the frame at once and it stays stored until acked; a connection is not sent the same frame twice', async () => {
  const r = await pairedDurable(db);
  await r.mac.say(frame('m2p', 1));
  assert.deepEqual(ctrs(r.phone.socket), [1]);
  await r.mac.say(frame('m2p', 2));
  await r.mac.say(frame('m2p', 2));
  assert.deepEqual(ctrs(r.phone.socket), [1, 2]);
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), [1, 2]);
});

test('acks may arrive out of order: only the acked frames are forgotten, the rest keep their order', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  for (const n of [1, 2, 3, 4]) await r.mac.say(frame('m2p', n));
  const ph = await reconnect(r, 'ph1', 'phone');
  await ph.say(ack('m2p', 3));
  await ph.say(ack('m2p', 1));
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), [2, 4]);
});

test('the Mac receives the phone’s frames the same way', async () => {
  const r = await pairedDurable(db);
  r.mac.h.close(1000);
  await settle(r.hub);
  await r.phone.say(frame('p2m', 1));
  const mac = await reconnect(r, 'mac1', 'desktop');
  assert.deepEqual(ctrs(mac.socket), [1]);
  await mac.say(ack('p2m', 1));
  assert.deepEqual(ctrs((await reconnect(r, 'mac1', 'desktop')).socket), []);
});

test('a backlog larger than one batch is delivered whole and in order', async () => {
  const r = await pairedDurable(db, { mailbox: { ...MAILBOX, maxFrames: 500 } });
  r.phone.h.close(1000);
  await settle(r.hub);
  for (let n = 1; n <= 120; n++) await r.mac.say(frame('m2p', n));
  const ph = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(
    ctrs(ph.socket),
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
});

test('a retried frame is idempotent: the same bytes are acked again, other bytes under the same counter are refused, an acked counter is consumed', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 1));
  assert.deepEqual(
    r.mac.socket.of('ack').map((a: any) => a.via),
    ['mailbox', 'mailbox'],
  );
  await r.mac.say(frame('m2p', 1, { box: b64(40, 9) }));
  assert.deepEqual(r.mac.socket.last(), { t: 'error', code: 'ctr_conflict', pair: P, ctr: 1 });
  const ph = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(ph.socket), [1], 'stored once');
  await ph.say(ack('m2p', 1));
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.mac.socket.last().via, 'consumed');
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), []);
});

test('a full mailbox refuses the next frame; the cap is per pair and acks make room', async () => {
  const r = await pairedDurable(db, { mailbox: { ...MAILBOX, maxFrames: 2 } });
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 2));
  await r.mac.say(frame('m2p', 3));
  assert.deepEqual(r.mac.socket.last(), { t: 'error', code: 'mailbox_full', pair: P, ctr: 3, scope: 'pair' });
  const ph = await reconnect(r, 'ph1', 'phone');
  await ph.say(ack('m2p', 1));
  await r.mac.say(frame('m2p', 3));
  assert.equal(r.mac.socket.last().via, 'mailbox');
});

test('two phones of one account have separate pairs: acking on one forgets nothing on the other', async () => {
  const r = await pairedDurable(db);
  const P2 = 'p_pair00002';
  const phone2 = await r.join('u1', 'ph2', 'phone');
  await r.mac.say({ t: 'pair.register', pair: P2 });
  await phone2.say({ t: 'pair.join', pair: P2 });
  r.phone.h.close(1000);
  phone2.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 1, { pair: P2, box: b64(40, 7) }));
  const a = await reconnect(r, 'ph1', 'phone');
  const b = await reconnect(r, 'ph2', 'phone');
  assert.deepEqual([ctrs(a.socket), ctrs(b.socket)], [[1], [1]]);
  await a.say(ack('m2p', 1));
  await a.say(ack('m2p', 1, P2));
  assert.equal(a.socket.last().code, 'unknown_pair', 'a phone cannot ack on a pair that is not its own');
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), []);
  assert.deepEqual(ctrs((await reconnect(r, 'ph2', 'phone')).socket), [1]);
});

test('acks are checked: shape, direction, pair membership and the revoked', async () => {
  const r = await pairedDurable(db);
  await r.phone.say(ack('m2p', 0));
  assert.deepEqual(r.phone.socket.last(), { t: 'error', code: 'bad_ack', pair: P });
  await r.phone.say(ack('p2m', 1));
  assert.equal(r.phone.socket.last().code, 'bad_dir', 'a sender cannot ack its own direction');
  await r.phone.say(ack('m2p', 1, 'p_nopair0001'));
  assert.equal(r.phone.socket.last().code, 'unknown_pair');
  const stranger = await r.join('u9', 'ph9', 'phone');
  await stranger.say(ack('m2p', 1));
  assert.equal(stranger.socket.last().code, 'unknown_pair');
  await db.query("INSERT INTO relay_revoked_devices (device_id,user_id,revoked_at) VALUES ('ph1','u1',now())");
  await r.phone.say(ack('m2p', 1));
  assert.equal(r.phone.socket.last().code, 'unknown_pair');
  await r.mac.say(frame('m2p', 5));
  assert.equal(r.mac.socket.last().code, 'unknown_pair', 'a revoked peer ends the pair for the sender too');
});

test('a retired epoch is replaced: a pair removed and created again stores under the new epoch', async () => {
  const r = await pairedDurable(db);
  await r.mac.say(frame('m2p', 1));
  await r.store.removePair(P); // behind the hub's back, so its cached epoch is stale
  await r.mac.say({ t: 'pair.register', pair: P });
  await r.phone.say({ t: 'pair.join', pair: P });
  r.mac.socket.sent.length = 0;
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.mac.socket.last().via, 'mailbox');
});

test('removing a pair or revoking a device forgets its epoch', async () => {
  const r = await pairedDurable(db);
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.hub.mailbox.epochs.has(P), true);
  await r.mac.say({ t: 'pair.remove', pair: P });
  assert.equal(r.hub.mailbox.epochs.has(P), false);
  const q = await pairedDurable(db);
  await q.mac.say(frame('m2p', 1));
  await q.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  assert.equal(q.hub.mailbox.epochs.has(P), false);
});

test('after the TTL the frame is dropped, never delivered, and the sender hears once, now or when it next connects', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 2));
  r.clock.advance(MAILBOX.ttlMs + 1);
  await r.hub.sweep();
  assert.deepEqual(r.mac.socket.events('mailbox.dropped'), [
    { t: 'event', ev: 'mailbox.dropped', pair: P, dir: 'm2p', count: 2, firstCtr: 1, lastCtr: 2 },
  ]);
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), []);
  await r.hub.sweep();
  assert.equal(r.mac.socket.events('mailbox.dropped').length, 1, 'told once');
  // a sender that was offline at the sweep is told at its next connect
  r.mac.h.close(1000);
  await settle(r.hub);
  const live = await reconnect(r, 'ph1', 'phone');
  await live.say(frame('p2m', 1));
  live.h.close(1000);
  await settle(r.hub);
  r.clock.advance(MAILBOX.ttlMs + 1);
  await r.hub.sweep();
  const phone = await reconnect(r, 'ph1', 'phone');
  assert.equal(phone.socket.events('mailbox.dropped').length, 1);
  assert.equal((await reconnect(r, 'ph1', 'phone')).socket.events('mailbox.dropped').length, 0);
});

test('an expired frame is not delivered even before the sweep, and its late ack is ignored', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  r.clock.advance(MAILBOX.ttlMs + 1);
  const ph = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(ph.socket), []);
  await ph.say(ack('m2p', 1));
  assert.equal(ph.socket.of('error').length, 0);
  await r.hub.sweep();
  assert.equal(r.mac.socket.events('mailbox.dropped').length, 1, 'still reported to the sender');
});

test('a sweep skips a pair that lost nothing or is gone, and a drop notice is kept if the sender’s socket refuses it', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  const real = r.hub.mailbox.durable.dueExpiry.bind(r.hub.mailbox.durable);
  r.hub.mailbox.durable.dueExpiry = async () => [
    { pairId: P, epoch: (await db.query('SELECT epoch FROM remote_durable.epochs')).rows[0].epoch },
  ];
  await r.hub.sweep();
  assert.equal(r.mac.socket.events('mailbox.dropped').length, 0, 'nothing had expired');
  r.hub.mailbox.durable.dueExpiry = real;
  r.clock.advance(MAILBOX.ttlMs + 1);
  r.mac.socket.failSend = true;
  await r.hub.sweep();
  r.mac.socket.failSend = false;
  assert.equal((await db.query('SELECT 1 FROM remote_durable.drops')).rows.length, 1, 'kept for the next connect');
  assert.equal((await reconnect(r, 'mac1', 'desktop')).socket.events('mailbox.dropped').length, 1);
  // a pair that is gone has nothing left to report
  r.hub.mailbox.durable.dueExpiry = async () => [{ pairId: 'p_gone000001', epoch: 'x' }];
  await r.hub.sweep();
});

test('a socket that refuses a send does not advance the cursor; the frame goes out on the next kick', async () => {
  const r = await pairedDurable(db);
  r.phone.socket.failSend = true;
  await r.mac.say(frame('m2p', 1));
  assert.deepEqual(ctrs(r.phone.socket), []);
  r.phone.socket.failSend = false;
  await r.hub.kick(r.hub.conns.get('ph1')!);
  assert.deepEqual(ctrs(r.phone.socket), [1]);
});

test('a frame of counter 0, the pairing hello, still takes the plain mailbox and is deleted once sent', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 0));
  assert.equal(r.mac.socket.last().via, 'mailbox');
  const ph = await reconnect(r, 'ph1', 'phone');
  assert.deepEqual(ctrs(ph.socket), [0]);
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), []);
});

test('the relay never learns what a box holds: stored rows are the sealed bytes the sender gave', async () => {
  const r = await pairedDurable(db);
  r.phone.h.close(1000);
  await settle(r.hub);
  await r.mac.say(frame('m2p', 1));
  const { rows } = await db.query('SELECT box FROM remote_durable.frames');
  assert.deepEqual(Buffer.from(rows[0].box), Buffer.alloc(40, 1));
});

test('a pair that is not joined yet has nothing to store or report, and a revoked pair never opens an epoch', async () => {
  const r = makeHub(db, { durable: true });
  const mac = await r.join('u1', 'mac1', 'desktop');
  await mac.say({ t: 'pair.register', pair: P });
  const again = await r.join('u1', 'mac1', 'desktop');
  assert.equal(again.socket.of('error').length, 0);
  const q = await pairedDurable(db);
  await db.query("INSERT INTO relay_revoked_devices (device_id,user_id,revoked_at) VALUES ('ph1','u1',now())");
  await q.mac.say(frame('m2p', 1));
  assert.equal(q.mac.socket.last().code, 'unknown_pair');
});

test('a receiver acknowledging a long backlog at once is not cut off, and every frame is forgotten', async () => {
  const r = await pairedDurable(db, { mailbox: { ...MAILBOX, maxFrames: 1000 } });
  r.phone.h.close(1000);
  await settle(r.hub);
  const N = 450;
  for (let n = 1; n <= N; n++) await r.mac.say(frame('m2p', n));
  const back = await reconnect(r, 'ph1', 'phone');
  assert.equal(ctrs(back.socket).length, N, 'the whole backlog is delivered');
  // the receiver acks every frame the moment it has it: far more than the relay can handle one at a time
  for (let n = 1; n <= N; n++) back.h.message(JSON.stringify(ack('m2p', n)));
  assert.equal(back.socket.closedWith, null, 'acks are what a receiver owes, not a flood');
  await settle(r.hub);
  assert.equal(back.socket.of('error').length, 0);
  assert.deepEqual(ctrs((await reconnect(r, 'ph1', 'phone')).socket), [], 'nothing is left to redeliver');
});

test('other messages still stop at the pending limit while acks are owed', async () => {
  const r = await pairedDurable(db, { mailbox: { ...MAILBOX, maxFrames: 1000 } });
  for (let i = 0; i < 250; i++) r.phone.h.message(JSON.stringify(ack('m2p', 1)));
  assert.equal(r.phone.socket.closedWith, null);
  for (let i = 0; i < 2005; i++) r.phone.h.message(JSON.stringify({ t: 'push.unregister' }));
  assert.deepEqual(r.phone.socket.closedWith, { code: 1008, reason: 'too many pending messages' });
  await settle(r.hub);
});

test('acks beyond what the mailbox can hold are cut off', async () => {
  const r = await pairedDurable(db, { mailbox: { ...MAILBOX, maxFrames: 100 } });
  for (let i = 0; i < 2005; i++) r.phone.h.message(JSON.stringify(ack('m2p', 1)));
  assert.deepEqual(r.phone.socket.closedWith, { code: 1008, reason: 'too many pending messages' });
  await settle(r.hub);
});

test('a message that only mentions "ack", or is a broken one, is not taken for a receipt', async () => {
  const r = await pairedDurable(db);
  await r.phone.say({ t: 'presence', state: 'ack' });
  assert.equal(r.phone.socket.last().code, 'bad_message');
  r.phone.h.message('{"t":"ack",');
  await settle(r.hub);
  assert.equal(r.phone.socket.last().code, 'bad_message');
  assert.equal(r.phone.socket.closedWith, null);
});
