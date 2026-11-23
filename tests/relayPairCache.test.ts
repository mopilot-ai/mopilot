// The hub's short-lived cache of pair rows and device pair lists: it saves a database read per frame and receipt, and every change the hub makes (register, join, remove, revoke) drops what it touched, so a cached row never outlives the change that made it wrong.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PairCache } from '../relay/src/pairCache.mjs';
import { makeDb, makeHub, makeClock, settle, P, frame, paired as pairedOn } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = (o: Parameters<typeof makeHub>[1] = {}) => pairedOn(db, o);

test('the cache serves a key until its lifetime ends or it is dropped, and a load that raced a drop is not stored', async () => {
  const clock = makeClock();
  const cache = new PairCache(clock.now, 1000);
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await cache.get('pair:a', load), 1);
  assert.equal(await cache.get('pair:a', load), 1);
  clock.advance(1001);
  assert.equal(await cache.get('pair:a', load), 2);
  cache.drop('a', ['d1', null, undefined]);
  assert.equal(await cache.get('pair:a', load), 3);
  // a read that began before a change finishes after it: its answer is returned to its caller but never kept
  let release = () => {};
  const slow = cache.get('device:d1', () => new Promise<string>((resolve) => (release = () => resolve('old'))));
  cache.drop('a', ['d1']);
  release();
  assert.equal(await slow, 'old');
  assert.equal(await cache.get('device:d1', async () => 'new'), 'new');
  cache.clear();
  assert.equal(await cache.get('pair:a', load), 4);
  // an answer of "not there" is not kept when the caller says so, so asking for ids that do not exist cannot fill the cache
  let misses = 0;
  const missing = async () => (misses++, null);
  await cache.get('pair:none', missing, false);
  await cache.get('pair:none', missing, false);
  assert.equal(misses, 2);
  await cache.get('device:none', missing);
  await cache.get('device:none', missing);
  assert.equal(misses, 3, 'by default a null is kept like any answer');
  const raced = cache.get('pair:b', () => new Promise<number>((resolve) => (release = () => resolve(9))));
  cache.clear();
  release();
  await raced;
  assert.equal(await cache.get('pair:b', async () => 10), 10);
});

test('a pair removed through the hub is forgotten at once: the next frame on it is unknown_pair, not served from the cache', async () => {
  const r = await paired();
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.mac.socket.last().via, 'live');
  await r.phone.say({ t: 'pair.remove', pair: P });
  await r.mac.say(frame('m2p', 2));
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
});

test('a revoked device cannot keep sending on a cached pair, and its peer is told the pair is gone', async () => {
  const r = await paired();
  await r.phone.say(frame('p2m', 1));
  await r.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  await r.mac.say(frame('m2p', 1));
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
});

test('a pair the phone joins is seen by the Mac that had cached its pending state', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  // the Mac's kick has already read its pair list with the phone not yet joined
  await r.hub.kick(r.hub.conns.get('mac1')!);
  await phone.say({ t: 'pair.join', pair: P });
  await phone.say(frame('p2m', 0, { dir: 'p2m' }));
  assert.equal(mac.socket.of('frame').length, 1, "the Mac was sent the phone's frame, so its pair list was refreshed by the join");
});

test('a cached row expires with its lifetime: a change made behind the hub is seen within a minute', async () => {
  const r = await paired();
  await r.mac.say(frame('m2p', 1));
  await db.query('DELETE FROM relay_pairs');
  await r.mac.say(frame('m2p', 2));
  assert.equal(r.mac.socket.last().via, 'live', 'still cached');
  r.clock.advance(61_000);
  await r.mac.say(frame('m2p', 3));
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
});

test('the plain mailbox is read only for a pair that stored something since the last read', async () => {
  const r = await paired();
  let reads = 0;
  const waiting = r.store.waiting.bind(r.store);
  r.store.waiting = async (...a: [string, string, number]) => (reads++, waiting(...a));
  // a frame the phone cannot take now (its socket is mid-drain) is stored plain, then delivered by the next kick
  const phone = r.hub.conns.get('ph1')!;
  phone.draining = true;
  await r.mac.say(frame('m2p', 0));
  assert.equal(r.mac.socket.last().via, 'mailbox');
  phone.draining = false;
  await r.hub.kick(phone);
  assert.equal(r.phone.socket.of('frame').length, 1);
  const afterDelivery = reads;
  await r.hub.kick(phone);
  await r.hub.kick(phone);
  assert.equal(reads, afterDelivery, 'nothing is waiting, so the plain mailbox is not asked');
  // a connection that has just started reads it for every pair
  const again = await r.join('u1', 'ph1', 'phone');
  assert.ok(reads > afterDelivery);
  assert.equal(again.socket.of('frame').length, 0);
});

test('a plain frame stored while a delivery is reading the mailbox is not lost to that delivery clearing its mark', async () => {
  const r = await paired();
  const phone = r.hub.conns.get('ph1')!;
  const waiting = r.store.waiting.bind(r.store);
  let reads = 0;
  let gate: (() => void) | undefined;
  r.store.waiting = async (...a: [string, string, number]) => {
    reads++;
    // the first read answers "nothing" after the sender has stored a frame (the read began before the store committed)
    if (reads === 1) {
      await new Promise<void>((resolve) => (gate = resolve));
      return [];
    }
    return waiting(...a);
  };
  r.hub.plainWaiting.add(`${P}:m2p`);
  const kicking = r.hub.kick(phone);
  await waitFor(() => gate !== undefined, 'the plain mailbox read being held');
  assert.equal(phone.draining, true);
  // the Mac's frame finds its peer mid-delivery, so it goes to the plain mailbox and asks for another delivery
  await r.mac.say(frame('m2p', 0));
  assert.equal(r.mac.socket.last().via, 'mailbox');
  gate!();
  await kicking;
  await settle(r.hub);
  assert.equal(r.phone.socket.of('frame').length, 1, 'the second pass of the delivery found the frame');
  assert.equal(r.hub.plainWaiting.has(`${P}:m2p`), false);
});

test('a plain mailbox read in full is asked for while a delivery is running: the running delivery does it on its next pass', async () => {
  const r = await paired();
  const phone = r.hub.conns.get('ph1')!;
  // a row stored while the relay was down: nothing marks it
  await r.store.enqueue({
    pairId: P,
    dir: 'm2p',
    ctr: 0,
    nonce: Buffer.alloc(24),
    box: Buffer.alloc(10, 7),
    now: r.clock.t,
    ttlMs: 60_000,
    maxFrames: 10,
    maxBytes: 10_000,
  });
  r.hub.plainWaiting.clear();
  const getPairs = r.hub.pairsOf.bind(r.hub);
  let gate: (() => void) | undefined;
  let held = false;
  r.hub.pairsOf = async (id: string) => {
    if (!held) {
      held = true;
      await new Promise<void>((resolve) => (gate = resolve));
    }
    return getPairs(id);
  };
  const first = r.hub.kick(phone);
  await waitFor(() => gate !== undefined, 'the pair read being held');
  await r.hub.kick(phone, true);
  assert.equal(phone.fullPending, true);
  gate!();
  await first;
  assert.equal(r.phone.socket.of('frame').length, 1, 'the full read was not lost');
  assert.equal(phone.fullPending, false);
});

test('a plain read that fails or stops short leaves its mark for the next delivery', async () => {
  const r = await paired();
  const phone = r.hub.conns.get('ph1')!;
  r.hub.plainWaiting.add(`${P}:m2p`);
  const waiting = r.store.waiting.bind(r.store);
  r.store.waiting = async () => {
    throw new Error('db down');
  };
  await assert.rejects(r.hub.kick(phone), /db down/);
  assert.equal(r.hub.plainWaiting.has(`${P}:m2p`), true);
  r.store.waiting = waiting;
  // the socket stops taking frames half-way: the rest stay, and so does the mark
  await r.store.enqueue({
    pairId: P,
    dir: 'm2p',
    ctr: 0,
    nonce: Buffer.alloc(24),
    box: Buffer.alloc(10, 7),
    now: r.clock.t,
    ttlMs: 60_000,
    maxFrames: 10,
    maxBytes: 10_000,
  });
  r.phone.socket.failSend = true;
  await r.hub.kick(phone);
  assert.equal(r.hub.plainWaiting.has(`${P}:m2p`), true);
  r.phone.socket.failSend = false;
  await r.hub.kick(phone);
  assert.equal(r.phone.socket.of('frame').length, 1);
  assert.equal(r.hub.plainWaiting.has(`${P}:m2p`), false);
});
