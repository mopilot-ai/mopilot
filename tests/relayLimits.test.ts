// The relay's limits on what one client may do: frames per second per connection and per pair (slowed, not refused), other messages per connection (refused with the wait), connections per account and in all, and the mailbox quota across every pair.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, Buckets } from '../relay/src/rateLimit.mjs';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeHub, makeClock, settle, FakeSocket, P, frame, MAILBOX } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
await migrateDurable(db);
beforeEach(reset);

/** A hub whose waits are recorded and cost no time, on a clock they advance. */
function throttled(limits: object, o: Parameters<typeof makeHub>[1] = {}) {
  const waits: number[] = [];
  const clock = makeClock();
  const sleep = async (ms: number) => {
    waits.push(ms);
    clock.advance(ms);
  };
  const r = makeHub(db, { clock, sleep, durable: true, limits, mailbox: { ...MAILBOX, maxFrames: 5000 }, ...o });
  return { ...r, waits };
}

async function pair(r: ReturnType<typeof throttled>) {
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  mac.socket.sent.length = 0;
  phone.socket.sent.length = 0;
  return { mac, phone };
}

test('a bucket refills with the clock, goes into debt and says how long the debt is; tryTake leaves it alone when it refuses', () => {
  const clock = makeClock();
  const b = new TokenBucket(10, 5, clock.now);
  assert.equal(b.take(5), 0);
  assert.equal(b.take(1), 100, 'one token short at 10 a second is 100 ms');
  assert.equal(b.take(2), 300);
  clock.advance(400);
  assert.equal(b.take(1), 0, '3 tokens in debt, 4 refilled, 1 taken');
  assert.equal(b.take(1), 100);
  clock.advance(10_000);
  assert.equal(b.take(5), 0, 'refilled, capped at the burst');
  const t = new TokenBucket(10, 3, clock.now);
  assert.equal(t.tryTake(3), 0);
  assert.equal(t.tryTake(1), 100);
  assert.equal(t.tryTake(1), 100, 'a refusal takes nothing');
  clock.advance(100);
  assert.equal(t.tryTake(1), 0);
});

test('buckets by key are made on first use and forgotten once they are full again', () => {
  const clock = makeClock();
  const buckets = new Buckets(10, 5, clock.now);
  const a = buckets.get('a');
  assert.equal(buckets.get('a'), a);
  a.take(5);
  buckets.get('b');
  assert.equal(buckets.size, 2);
  buckets.prune();
  assert.equal(buckets.size, 1, 'b was never used, so it is full; a is not');
  clock.advance(1000);
  buckets.prune();
  assert.equal(buckets.size, 0);
});

test("frames beyond a connection's burst are slowed to its rate, all stored in order, none refused", async () => {
  const r = throttled({ frameRate: 10, frameBurst: 5, pairFrameRate: 1000, pairFrameBurst: 1000 });
  const { mac, phone } = await pair(r);
  for (let ctr = 1; ctr <= 8; ctr++) mac.h.message(JSON.stringify(frame('m2p', ctr)));
  await settle(r.hub);
  assert.deepEqual(r.waits, [100, 100, 100], 'frames 6, 7 and 8 each wait 100 ms for their token');
  assert.deepEqual(
    mac.socket.of('ack').map((a) => a.ctr),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    phone.socket.of('frame').map((f) => f.ctr),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(mac.socket.of('error').length, 0);
});

test("both ends of a pair share its rate: the Mac and the phone together are held to the pair's limit", async () => {
  const r = throttled({ frameRate: 1000, frameBurst: 1000, pairFrameRate: 10, pairFrameBurst: 4 });
  const { mac, phone } = await pair(r);
  for (let ctr = 1; ctr <= 3; ctr++) mac.h.message(JSON.stringify(frame('m2p', ctr)));
  for (let ctr = 1; ctr <= 3; ctr++) phone.h.message(JSON.stringify(frame('p2m', ctr)));
  await settle(r.hub);
  assert.equal(r.waits.length, 2, 'the fifth and sixth frames of the pair waited');
  assert.equal(mac.socket.of('ack').length, 3);
  assert.equal(phone.socket.of('ack').length, 3);
  assert.equal(r.hub.pairBuckets.size, 1);
  r.hub.tick();
  r.clock.advance(5000);
  r.hub.tick();
  assert.equal(r.hub.pairBuckets.size, 0, "a pair's bucket goes once it is full again");
});

test('a frame for a pair the connection does not belong to costs a token of its own but makes no pair bucket', async () => {
  const r = throttled({ frameRate: 1, frameBurst: 1, pairFrameRate: 1, pairFrameBurst: 1 });
  const { mac } = await pair(r);
  for (let i = 0; i < 4; i++) await mac.say(frame('m2p', 1, { pair: 'p_otherpair1' }));
  assert.equal(r.hub.pairBuckets.size, 0);
  assert.deepEqual(
    r.waits,
    [1000, 1000, 1000],
    'the first was free, each later one waited for its token before being answered unknown_pair',
  );
  assert.equal(mac.socket.of('error').filter((e) => e.code === 'unknown_pair').length, 4);
  assert.equal(r.hub.cache.entries.size <= 2, true, 'a pair that does not exist is not cached');
});

test('the buckets belong to the device: a reconnect does not give it a full burst again', async () => {
  const r = throttled({ frameRate: 1, frameBurst: 3, controlRate: 1, controlBurst: 2 });
  const { mac } = await pair(r);
  for (let i = 1; i <= 3; i++) mac.h.message(JSON.stringify(frame('m2p', i)));
  await settle(r.hub);
  assert.deepEqual(r.waits, []);
  const again = await r.join('u1', 'mac1', 'desktop');
  for (let i = 4; i <= 5; i++) again.h.message(JSON.stringify(frame('m2p', i)));
  await settle(r.hub);
  assert.deepEqual(r.waits, [1000, 1000], 'both waited: the burst was spent by the first socket (a fresh one would have passed)');
});

test('a debt longer than the longest wait closes the connection as a flood; frames before it were stored', async () => {
  const r = throttled({ frameRate: 1, frameBurst: 2, maxWaitMs: 3000 });
  const { mac } = await pair(r);
  // time does not pass while a frame waits, so the debt of a flood builds up
  r.hub.sleep = async () => undefined;
  for (let i = 1; i <= 7; i++) mac.h.message(JSON.stringify(frame('m2p', i)));
  await settle(r.hub);
  assert.deepEqual(mac.socket.closedWith, { code: 1008, reason: 'rate limited' });
  const stored = await db.query('SELECT ctr FROM remote_durable.frames ORDER BY ctr');
  assert.deepEqual(
    stored.rows.map((x: any) => Number(x.ctr)),
    [1, 2, 3, 4, 5],
    'the frames inside the allowed wait (2 free, 3 delayed up to 3 s) are stored; the 6th was 4 s in debt',
  );
});

test('a clock that steps back puts no bucket into debt', () => {
  const clock = makeClock();
  const b = new TokenBucket(100, 10, clock.now);
  assert.equal(b.take(10), 0);
  clock.advance(-30_000);
  assert.equal(b.take(1), 10, 'the same instant as before: one token short, not thirty seconds of debt');
  assert.equal(b.tryTake(1), 20, 'one token in debt, one wanted');
  assert.equal(b.idle, false);
});

test('a socket the transport has closed is not slowed for its queued frames, and does not count against a cap', async () => {
  const r = throttled({ frameRate: 1, frameBurst: 1, maxConnectionsPerAccount: 2 });
  const { mac, phone } = await pair(r);
  for (let i = 1; i <= 4; i++) mac.h.message(JSON.stringify(frame('m2p', i)));
  mac.h.close(1006);
  await settle(r.hub);
  assert.equal(r.waits.length <= 1, true, 'at most the frame being handled when the close came waited');
  const stored = await db.query('SELECT count(*) AS n FROM remote_durable.frames');
  assert.equal(Number(stored.rows[0].n), 4, 'what the client had sent is still stored');
  assert.equal(phone.socket.of('frame').length, 4);
  assert.equal(r.hub.refusal({ userId: 'u1', deviceId: 'd9', kind: 'desktop', expMs: 1 }), null, 'only the phone is left of the account');
  const closing = await r.join('u1', 'mac2', 'desktop');
  closing.h.close(1006);
  assert.equal(
    closing.h && r.hub.refusal({ userId: 'u1', deviceId: 'd9', kind: 'desktop', expMs: 1 }),
    null,
    'a socket the transport closed does not count even before its close is handled',
  );
});

test('a device that reconnects too fast is closed 1013 until its connects have refilled', async () => {
  const r = throttled({ connectRate: 1, connectBurst: 2 });
  await r.join('u1', 'd1', 'desktop');
  await r.join('u1', 'd1', 'desktop');
  const third = await r.join('u1', 'd1', 'desktop');
  assert.deepEqual(third.socket.closedWith, { code: 1013, reason: 'reconnecting too fast' });
  r.clock.advance(1000);
  const fourth = await r.join('u1', 'd1', 'desktop');
  assert.equal(fourth.socket.closedWith, null);
});

test("receipts are paced on their own bucket, which a returning receiver's whole backlog fits in", async () => {
  const r = throttled({ receiptRate: 10, receiptBurst: 3 });
  const { phone } = await pair(r);
  for (let ctr = 1; ctr <= 5; ctr++) phone.h.message(JSON.stringify({ t: 'ack', pair: P, dir: 'm2p', ctr }));
  await settle(r.hub);
  assert.deepEqual(r.waits, [100, 100], 'the fourth and fifth receipts each waited for one token');
});

test('a client closing or the relay stopping while a frame waits for its token ends the wait without storing it', async () => {
  const r = throttled({ frameRate: 1, frameBurst: 1 });
  const { mac } = await pair(r);
  let release: (() => void) | undefined;
  r.hub.sleep = () => new Promise<void>((resolve) => (release = resolve));
  mac.h.message(JSON.stringify(frame('m2p', 1)));
  mac.h.message(JSON.stringify(frame('m2p', 2)));
  await waitFor(() => release !== undefined, 'the frame entering its pace wait before close');
  r.hub.conns.get('mac1')!.closed = true;
  release!();
  await settle(r.hub);
  const stored = await db.query('SELECT ctr FROM remote_durable.frames ORDER BY ctr');
  assert.deepEqual(
    stored.rows.map((x: any) => Number(x.ctr)),
    [1],
    'the frame that did not wait was stored, the one that did was not',
  );
  const r2 = throttled({ frameRate: 1, frameBurst: 1 });
  const again = await pair(r2).catch(() => null);
  assert.ok(again);
  let free: (() => void) | undefined;
  r2.hub.sleep = () => new Promise<void>((resolve) => (free = resolve));
  again!.mac.h.message(JSON.stringify(frame('m2p', 5)));
  again!.mac.h.message(JSON.stringify(frame('m2p', 6)));
  await waitFor(() => free !== undefined, 'the frame entering its pace wait before shutdown');
  r2.hub.draining = true;
  free!();
  await settle(r2.hub);
  assert.equal(again!.mac.socket.of('ack').filter((a) => a.ctr === 6).length, 0);
  const left = await db.query("SELECT ctr FROM remote_durable.frames WHERE pair_id = 'p_pair00001' ORDER BY ctr");
  assert.equal(
    left.rows.some((x: any) => Number(x.ctr) === 6),
    false,
    'the frame that waited while the relay was stopping was not stored',
  );
});

test('pairing, presence, push and token-refresh messages beyond the burst are refused with rate_limited and the wait; receipts use their own bucket', async () => {
  const r = throttled({ controlRate: 2, controlBurst: 3 });
  const { mac } = await pair(r);
  for (let i = 0; i < 5; i++) mac.h.message(JSON.stringify({ t: 'presence', state: 'online', rid: `p${i}` }));
  await settle(r.hub);
  const replies = mac.socket.sent.filter((m) => m.rid?.startsWith('p'));
  assert.deepEqual(
    replies.map((m) => m.t === 'ok' || m.code),
    [true, true, 'rate_limited', 'rate_limited', 'rate_limited'],
  );
  assert.ok(replies[2].retryAfterMs > 0 && replies[2].retryAfterMs <= 1000);
  // a token refresh is a control message too (it costs a JWT verification); a receipt is paced by its own bucket
  r.identities.set('fresh', { userId: 'u1', deviceId: 'mac1', kind: 'desktop', expMs: r.clock.t + 900_000 });
  await mac.say({ t: 'auth', token: 'fresh', rid: 'a' });
  assert.deepEqual(mac.socket.last(), { t: 'error', code: 'rate_limited', rid: 'a', retryAfterMs: mac.socket.last().retryAfterMs });
  const before = mac.socket.sent.length;
  await mac.say({ t: 'ack', pair: P, dir: 'p2m', ctr: 1, rid: 'ack' });
  assert.equal(mac.socket.sent.length, before, 'a receipt is not refused by the control bucket (and a good one is not answered)');
  // the wait it named is enough
  r.clock.advance(replies[2].retryAfterMs);
  await mac.say({ t: 'presence', state: 'online', rid: 'later' });
  assert.equal(mac.socket.last().t, 'ok');
});

test('a device may connect until its account holds the limit; its own new socket replaces the old one and never counts', async () => {
  const r = throttled({ maxConnectionsPerAccount: 2, maxConnections: 100 });
  const a = await r.join('u1', 'd1', 'desktop');
  await r.join('u1', 'd2', 'phone');
  assert.equal(r.hub.refusal({ userId: 'u1', deviceId: 'd3', kind: 'desktop', expMs: 1 }), 'account_limit');
  assert.equal(r.hub.refusal({ userId: 'u2', deviceId: 'x1', kind: 'desktop', expMs: 1 }), null, 'another account is unaffected');
  assert.equal(r.hub.refusal({ userId: 'u1', deviceId: 'd1', kind: 'desktop', expMs: 1 }), null, 'a replacement of d1');
  const replacement = await r.join('u1', 'd1', 'desktop');
  assert.equal(a.socket.closedWith?.code, 4000);
  assert.equal(replacement.socket.closedWith, null);
  // the hub decides again when the socket starts, so two upgrades that both passed the early check cannot both stay
  const third = await r.join('u1', 'd3', 'desktop');
  assert.deepEqual(third.socket.closedWith, { code: 4429, reason: 'account_limit' });
  assert.equal(r.hub.conns.has('d3'), false);
});

test('the relay as a whole holds a limited number of sockets; a restarting relay takes none', async () => {
  const r = throttled({ maxConnections: 2, maxConnectionsPerAccount: 10 });
  await r.join('u1', 'd1', 'desktop');
  await r.join('u2', 'd2', 'desktop');
  assert.equal(r.hub.refusal({ userId: 'u3', deviceId: 'd3', kind: 'desktop', expMs: 1 }), 'busy');
  const busy = await r.join('u3', 'd3', 'desktop');
  assert.deepEqual(busy.socket.closedWith, { code: 4503, reason: 'capacity' });
  r.hub.draining = true;
  assert.equal(r.hub.refusal({ userId: 'u1', deviceId: 'd1', kind: 'desktop', expMs: 1 }), 'restarting');
});

test('the relay-wide mailbox limit refuses a new frame with scope relay, still acks a repeat of a stored one, and counts again from the database', async () => {
  const r = throttled({ globalMaxFrames: 2, globalMaxBytes: 1_000_000 });
  const { mac, phone } = await pair(r);
  await mac.say(frame('m2p', 1));
  await mac.say(frame('m2p', 2));
  await mac.say(frame('m2p', 3, { rid: 'third' }));
  assert.deepEqual(mac.socket.last(), { t: 'error', code: 'mailbox_full', rid: 'third', pair: P, ctr: 3, scope: 'relay' });
  await mac.say(frame('m2p', 2));
  assert.equal(mac.socket.last().via, 'mailbox', 'a repeat of a frame the relay holds is answered, not refused');
  // the phone's receipts free room, seen as soon as the count is read again
  await phone.say({ t: 'ack', pair: P, dir: 'm2p', ctr: 1 });
  await phone.say({ t: 'ack', pair: P, dir: 'm2p', ctr: 2 });
  await mac.say(frame('m2p', 4, { rid: 'still' }));
  assert.equal(mac.socket.last().code, 'mailbox_full', 'the count is trusted for a few seconds');
  r.clock.advance(11_000);
  await mac.say(frame('m2p', 5));
  assert.equal(mac.socket.last().via, 'mailbox');
});

test("the relay-wide byte limit counts the sealed bytes of every pair; a pair's own full mailbox says scope pair", async () => {
  const bytes = throttled({ globalMaxBytes: 100, globalMaxFrames: 1000 });
  const one = await pair(bytes);
  await one.mac.say(frame('m2p', 1, { box: Buffer.alloc(40, 1).toString('base64') }));
  await one.mac.say(frame('m2p', 2, { box: Buffer.alloc(40, 2).toString('base64'), rid: 'big' }));
  assert.equal(one.mac.socket.last().code, 'mailbox_full');
  assert.equal(one.mac.socket.last().scope, 'relay');
  await reset();
  const small = throttled({}, { mailbox: { ...MAILBOX, maxFrames: 1 } });
  const two = await pair(small);
  await two.mac.say(frame('m2p', 1));
  await two.mac.say(frame('m2p', 2, { rid: 'x' }));
  assert.equal(two.mac.socket.last().scope, 'pair');
});

test('a token refresh must be the same account, device and kind of device', async () => {
  const r = throttled({});
  const { phone } = await pair(r);
  r.identities.set('desktop-token', { userId: 'u1', deviceId: 'ph1', kind: 'desktop', expMs: r.clock.t + 900_000 });
  await phone.say({ t: 'auth', token: 'desktop-token' });
  assert.deepEqual(phone.socket.closedWith, { code: 4401, reason: 'auth' });
});

test('the relay-wide usage is read once for stores that ask together, and a database that cannot answer leaves the per-pair caps in charge', async () => {
  const r = throttled({ globalMaxFrames: 1 });
  const { mac } = await pair(r);
  const usage = r.hub.mailbox.durable.usage.bind(r.hub.mailbox.durable);
  let reads = 0;
  r.hub.mailbox.durable.usage = async () => (reads++, usage());
  for (let ctr = 1; ctr <= 3; ctr++) mac.h.message(JSON.stringify(frame('m2p', ctr)));
  await settle(r.hub);
  assert.equal(reads, 1, 'three stores at once, one read');
  assert.equal(mac.socket.of('ack').length, 1, 'the first fits the limit of one frame');
  assert.deepEqual(
    mac.socket.of('error').map((e) => e.scope),
    ['relay', 'relay'],
  );
  // the database cannot be read: the last count is kept for another interval and the failure is logged
  r.clock.advance(11_000);
  r.hub.mailbox.durable.usage = async () => {
    throw new Error('connection reset');
  };
  mac.h.message(JSON.stringify(frame('m2p', 4)));
  await settle(r.hub);
  assert.deepEqual(
    r.logs.filter(([e]) => e === 'usage_unreadable'),
    [['usage_unreadable', { message: 'connection reset' }]],
  );
  assert.equal(mac.socket.last().scope, 'relay', 'the last known count still says full');
  // a relay that has never read its usage lets the per-pair caps decide
  const fresh = throttled({ globalMaxFrames: 1 });
  const two = await pair(fresh);
  fresh.hub.mailbox.durable.usage = async () => {
    throw new Error('first read fails');
  };
  await two.mac.say(frame('m2p', 1));
  assert.equal(two.mac.socket.last().via, 'mailbox');
});

test('sockets that are still starting count against the caps, so a burst of upgrades cannot all pass', async () => {
  const r = throttled({ maxConnectionsPerAccount: 2 });
  const gate = r.store.isRevoked.bind(r.store);
  let release = () => {};
  r.store.isRevoked = async (id: string) => {
    await new Promise<void>((resolve) => (release = resolve));
    return gate(id);
  };
  r.hub.connect(new FakeSocket() as any, { userId: 'u1', deviceId: 'd1', kind: 'desktop', expMs: r.clock.t + 1000 });
  r.hub.connect(new FakeSocket() as any, { userId: 'u1', deviceId: 'd2', kind: 'desktop', expMs: r.clock.t + 1000 });
  assert.equal(r.hub.conns.size, 0, 'neither has registered yet');
  assert.equal(r.hub.refusal({ userId: 'u1', deviceId: 'd3', kind: 'desktop', expMs: 1 }), 'account_limit');
  release();
});

test('a pair flooded by its two ends together, and a receiver flooding receipts, are closed as floods too', async () => {
  const shared = throttled({ pairFrameRate: 1, pairFrameBurst: 1, frameRate: 1000, frameBurst: 1000, maxWaitMs: 2500 });
  const { mac } = await pair(shared);
  shared.hub.sleep = async () => undefined;
  for (let i = 1; i <= 6; i++) mac.h.message(JSON.stringify(frame('m2p', i)));
  await settle(shared.hub);
  assert.deepEqual(mac.socket.closedWith, { code: 1008, reason: 'rate limited' });
  const receipts = throttled({ receiptRate: 1, receiptBurst: 1, maxWaitMs: 2500 });
  const two = await pair(receipts);
  receipts.hub.sleep = async () => undefined;
  for (let ctr = 1; ctr <= 6; ctr++) two.phone.h.message(JSON.stringify({ t: 'ack', pair: P, dir: 'm2p', ctr }));
  await settle(receipts.hub);
  assert.deepEqual(two.phone.socket.closedWith, { code: 1008, reason: 'rate limited' });
});
