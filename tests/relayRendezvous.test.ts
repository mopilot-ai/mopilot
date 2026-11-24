// The relay's rendezvous for pairing two computers by a code (#5576, relay/src/rendezvous.mjs and its HTTP face): offers with a random id and a hint, claims that fail the same way whatever the cause, the limits that bound it (by IPv4 address or IPv6 /64, with every table capped), a small mailbox in turn and for the claim a side read, five minutes at most, a switch that is off by default, a page in a browser kept out, and nothing but counts in the metrics.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { Metrics } from '../relay/src/metrics.mjs';
import {
  ALPHABET,
  CLAIMS_PER_OFFER,
  LIMITS,
  MAX_BOX_CHARS,
  MAX_MESSAGES,
  OFFER_MS,
  callerOf,
  createRendezvous,
} from '../relay/src/rendezvous.mjs';
import { makeClock, makeDb, makeKeys } from './support/relayKit.ts';

type Limits = Record<keyof typeof LIMITS, number>;
const mk = (over: Partial<Limits> = {}) => {
  const clock = makeClock();
  const metrics = new Metrics();
  return { clock, metrics, rv: createRendezvous({ now: clock.now, metrics, limits: { ...LIMITS, ...over } }) as any };
};
const offerOf = (rv: any, account = 'u1', address = '10.0.0.1') => {
  const o = rv.offer({ account, address });
  assert.equal(o.ok, true);
  return o;
};
const wide = { claimsPerMinute: 1000, claimsPerHour: 1000, offersPerHour: 1000, perAccount: 1000 };

test('an offer has a random 128-bit id, a 3-character hint no live offer has, a ticket for its side and a five-minute life', () => {
  const { rv, clock } = mk(wide);
  const o = offerOf(rv);
  assert.match(o.id, /^r_[A-Za-z0-9_-]{22}$/);
  assert.match(o.hint, new RegExp(`^[${ALPHABET}]{3}$`));
  assert.equal(o.expiresAt, clock.now() + OFFER_MS);
  assert.ok(!/[01OIL]/.test(ALPHABET));
  const hints = new Set<string>();
  for (let i = 0; i < 400; i++) hints.add(offerOf(rv, `acc${i}`, `10.1.${i % 250}.${(i / 250) | 0}`).hint);
  assert.equal(hints.size, 400, 'no two live offers share a hint');
  assert.notEqual(offerOf(rv, 'x', '10.9.9.9').id, offerOf(rv, 'y', '10.9.9.8').id);
});

test('the relay, an account and a caller are each held to a limit, a closed offer frees its place, and a hint is found in a bounded number of tries', () => {
  const live = mk({ live: 3, perAccount: 2, offersPerHour: 4 });
  const a = offerOf(live.rv, 'u1', 'a1');
  offerOf(live.rv, 'u1', 'a2');
  assert.deepEqual(live.rv.offer({ account: 'u1', address: 'a3' }), { ok: false, reason: 'account_limit' });
  offerOf(live.rv, 'u2', 'a4');
  assert.deepEqual(live.rv.offer({ account: 'u3', address: 'a5' }), { ok: false, reason: 'busy' });
  assert.equal(live.rv.close({ id: a.id, ticket: a.ticket }), true);
  assert.equal(live.rv.offer({ account: 'u1', address: 'a6' }).ok, true, 'the place and the hint are free at once');
  assert.match(live.metrics.render(), /relay_rendezvous_refused\{why="busy"\} 1/);
  const hour = mk({ offersPerHour: 3, perAccount: 50 });
  for (let i = 0; i < 3; i++) offerOf(hour.rv, `u${i}`, 'same');
  assert.deepEqual(hour.rv.offer({ account: 'u9', address: 'same' }), { ok: false, reason: 'limited' });
  hour.clock.advance(3600_000);
  assert.equal(hour.rv.offer({ account: 'u9', address: 'same' }).ok, true, 'an hour later it is allowed again');
  // a relay that held nearly every hint says busy rather than looking for ever
  const full = mk({ live: 40_000, perAccount: 40_000, offersPerHour: 1_000_000, bucketCap: 100_000 });
  let busy = 0;
  for (let i = 0; i < 30_500; i++) {
    const r = full.rv.offer({ account: `a${i}`, address: `10.${(i >> 8) & 255}.${i & 255}.1` });
    if (!r.ok && !busy) busy = i;
  }
  assert.ok(busy > 25_000 && busy < 29_792, `busy after ${busy} offers, with only 29,791 hints`);
});

test('who a caller is: an IPv4 address, an IPv6 /64 (and its /48), a mapped address, anything else by its own text', () => {
  assert.deepEqual(callerOf('203.0.113.7'), { primary: '203.0.113.7', wide: null });
  assert.deepEqual(callerOf('::ffff:203.0.113.7'), { primary: '203.0.113.7', wide: null });
  assert.deepEqual(callerOf('2001:db8:aaaa:bbbb:1:2:3:4'), { primary: '2001:0db8:aaaa:bbbb/64', wide: '2001:0db8:aaaa/48' });
  assert.deepEqual(callerOf('2001:DB8:aaaa:bbbb::9'), { primary: '2001:0db8:aaaa:bbbb/64', wide: '2001:0db8:aaaa/48' });
  assert.deepEqual(callerOf('2001:db8::1%eth0'), { primary: '2001:0db8:0000:0000/64', wide: '2001:0db8:0000/48' });
  assert.deepEqual(callerOf('::1'), { primary: '0000:0000:0000:0000/64', wide: '0000:0000:0000/48' });
  for (const odd of ['', 'unix:/tmp/x', '1:2:3:4:5:6:7:8:9', '1::2::3', 'g::1', '1:2:3', ':::'])
    assert.equal(callerOf(odd).wide, null, odd);
  assert.equal(callerOf('x'.repeat(200)).primary.length, 64);
});

test('an IPv6 /64 is one caller however many addresses it makes, its /48 is held wider, and the tables of buckets are capped', () => {
  const { rv } = mk({ claimsPerMinute: 5, claimsPerHour: 100, offersPerHour: 2, perAccount: 100, wideFactor: 2, bucketCap: 50 });
  const o = offerOf(rv, 'u1', '2001:db8:1:1::1');
  // a million addresses of one /64 are the same caller: only its own few claims go through
  let taken = 0;
  let limited = 0;
  for (let i = 0; i < 50; i++) {
    const r = rv.claim({ hint: 'AAA', address: `2001:db8:1:1:${i.toString(16)}::${i}` });
    if (r === 'limited') limited++;
    else taken++;
  }
  assert.deepEqual([taken, limited], [5, 45]);
  // another /64 of the same /48 has its own bucket, but the /48 as a whole is held at twice a /64 and has spent it
  let more = 0;
  for (let i = 0; i < 20; i++) if (rv.claim({ hint: 'AAA', address: `2001:db8:1:${(i % 5) + 2}::1` }) !== 'limited') more++;
  assert.ok(more <= 5, `the /48's own limit held the other /64s to ${more}`);
  // offers: the same
  assert.equal(rv.offer({ account: 'u2', address: '2001:db8:2:1::1' }).ok, true);
  assert.equal(rv.offer({ account: 'u3', address: '2001:db8:2:1::2' }).ok, true);
  assert.deepEqual(rv.offer({ account: 'u4', address: '2001:db8:2:1::3' }), { ok: false, reason: 'limited' });
  assert.ok(o.ok);
  // a flood of distinct callers grows no table past its cap, and the callers past it share one bucket
  const flood = mk({ claimsPerMinute: 1, claimsPerHour: 1000, bucketCap: 10 });
  const before = flood.rv.buckets.reduce((a: number, b: number) => a + b, 0);
  let shared = 0;
  for (let i = 0; i < 5000; i++) if (flood.rv.claim({ hint: 'AAA', address: `10.${i >> 8}.${i & 255}.9` }) === 'limited') shared++;
  const grown = flood.rv.buckets.reduce((a: number, b: number) => a + b, 0) - before;
  assert.ok(grown <= 4 * 10, `the tables grew by ${grown} for 5000 callers`);
  assert.ok(shared > 4000, 'past the cap the callers share one bucket, which runs out');
  // a hint that is not one makes no bucket at all
  for (let i = 0; i < 1000; i++) assert.equal(flood.rv.claim({ hint: 'nope', address: `192.168.${i >> 8}.${i & 255}` }), null);
  assert.equal(flood.rv.buckets.reduce((a: number, b: number) => a + b, 0) - before - grown, 0);
});

test('an offer does not walk the tables: expired offers and full buckets go when the relay’s timer sweeps', () => {
  const { rv, clock } = mk(wide);
  offerOf(rv, 'u1', '10.0.0.1');
  offerOf(rv, 'u2', '10.0.0.2');
  clock.advance(OFFER_MS + 1);
  offerOf(rv, 'u3', '10.0.0.3');
  assert.equal(rv.size, 3, 'a new offer swept nothing');
  rv.sweep();
  assert.equal(rv.size, 1);
  clock.advance(7200_000);
  rv.sweep();
  assert.deepEqual(rv.buckets.slice(0, 6), [0, 0, 0, 0, 0, 0], 'buckets that refilled are gone');
});

test('a claim answers the same nothing for an unknown hint, an expired or used-up offer, a malformed hint and too many claims', () => {
  const { rv, clock } = mk(wide);
  const o = offerOf(rv);
  assert.equal(rv.claim({ hint: o.hint.toLowerCase(), address: 'a' })?.id, o.id, 'the hint is read in any case');
  for (const hint of ['ZZZ', 'a', '', 'O0I', 12, null, undefined, `${o.hint}X`]) assert.equal(rv.claim({ hint, address: 'a' }), null);
  for (let i = 1; i < CLAIMS_PER_OFFER; i++) assert.ok(rv.claim({ hint: o.hint, address: 'a' }));
  assert.equal(rv.claim({ hint: o.hint, address: 'a' }), null);
  const fresh = offerOf(rv, 'u2', 'b');
  clock.advance(OFFER_MS);
  assert.equal(rv.claim({ hint: fresh.hint, address: 'a' }), null, 'expired');
  assert.equal(rv.read({ id: fresh.id, ticket: fresh.ticket, after: 0 }).ok, false);
});

test('a stranger who guesses a live hint takes the claimant’s place and uses up the claims: pinned, with its cost to the person', () => {
  const { rv } = mk(wide);
  const o = offerOf(rv);
  const real = rv.claim({ hint: o.hint, address: 'real' });
  assert.equal(rv.send({ id: o.id, ticket: real.ticket, claims: real.claims, box: 'AAAA' }).ok, true);
  const stranger = rv.claim({ hint: o.hint, address: 'stranger' });
  assert.equal(rv.send({ id: o.id, ticket: real.ticket, claims: real.claims, box: 'BBBB' }).ok, false, 'the real claimant is nothing now');
  assert.deepEqual(rv.read({ id: o.id, ticket: o.ticket, after: 0 }).messages, [], 'and its message went with the claim');
  for (let i = 0; i < CLAIMS_PER_OFFER; i++) rv.claim({ hint: o.hint, address: 'stranger' });
  assert.equal(rv.claim({ hint: o.hint, address: 'real' }), null, 'the real claimant gets the same nothing as for any wrong code');
  assert.ok(stranger.claims < (rv.read({ id: o.id, ticket: o.ticket, after: 0 }) as any).claims, 'the Host reads the count of claims');
});

test('claims are limited per caller by the minute and by the hour, and say so in a way a guess cannot use', () => {
  const { rv, clock } = mk({ claimsPerMinute: 3, claimsPerHour: 5 });
  const o = offerOf(rv);
  for (let i = 0; i < 3; i++) rv.claim({ hint: 'AAA', address: 'x' });
  assert.equal(rv.claim({ hint: o.hint, address: 'x' }), 'limited');
  assert.ok(rv.claim({ hint: o.hint, address: 'y' }), 'another caller is not held by it');
  clock.advance(61_000);
  rv.claim({ hint: 'AAA', address: 'x' });
  rv.claim({ hint: 'AAA', address: 'x' });
  clock.advance(61_000);
  assert.equal(rv.claim({ hint: 'AAA', address: 'x' }), 'limited', 'the hour’s five are used');
});

test('the two sides exchange sealed messages by their tickets and the claim they read, in turn; each hears only the other’s, and a new claim starts again', () => {
  const { rv } = mk(wide);
  const o = offerOf(rv);
  const a = rv.claim({ hint: o.hint, address: 'a' });
  const sendA = (box: string, claims = a.claims, ticket = a.ticket) => rv.send({ id: o.id, ticket, claims, box });
  const sendB = (box: string, claims = a.claims) => rv.send({ id: o.id, ticket: o.ticket, claims, box });
  assert.deepEqual(sendA('AAAA'), { ok: true, n: 1 });
  assert.deepEqual(sendA('AAAB'), { ok: false, reason: 'wait' }, 'a side opens once before the other answers');
  assert.deepEqual(sendB('BBBB'), { ok: true, n: 2 });
  assert.deepEqual(sendB('BBBC'), { ok: false, reason: 'wait' });
  assert.deepEqual(rv.read({ id: o.id, ticket: o.ticket, after: 0 }).messages, [{ n: 1, box: 'AAAA' }]);
  assert.deepEqual(rv.read({ id: o.id, ticket: a.ticket, after: 0 }).messages, [{ n: 2, box: 'BBBB' }]);
  assert.deepEqual(rv.read({ id: o.id, ticket: a.ticket, after: 2 }).messages, []);
  assert.equal(rv.read({ id: o.id, ticket: a.ticket, after: -3 }).ok, true);
  assert.equal(rv.read({ id: o.id, ticket: a.ticket, after: 'x' as any }).ok, true);
  // a message for another claim, or none read, is nothing
  for (const claims of [0, 2, 1.5, '1' as any, undefined as any]) assert.equal(sendB('BBBD', claims).ok, false, `claims ${claims}`);
  // wrong, missing and the other offer's tickets are nothing
  const other = offerOf(rv, 'u2', 'b');
  for (const ticket of ['', 'x', null, other.ticket, `${a.ticket}x`]) assert.equal(sendA('AAAA', 1, ticket as any).ok, false);
  assert.equal(rv.send({ id: 'nope', ticket: a.ticket, claims: 1, box: 'AAAA' }).ok, false);
  // box shape and size
  for (const box of ['', 'a b', 'é', 5, 'A'.repeat(MAX_BOX_CHARS + 1)]) assert.deepEqual(sendA(box as any), { ok: false, reason: 'bad' });
  assert.equal(sendA('A'.repeat(MAX_BOX_CHARS)).ok, true);
  for (let i = 0; i < MAX_MESSAGES; i++) (i % 2 ? sendA : sendB)('AAAA');
  assert.deepEqual(rv.read({ id: o.id, ticket: o.ticket, after: 0 }).messages.length <= MAX_MESSAGES, true);
  assert.deepEqual(sendB('BBBB'), { ok: false, reason: 'full' });
  // a new claim takes the place of the old one: its ticket is nothing now, the messages are gone, and the Host's answer to the old claim lands nowhere
  const again = rv.claim({ hint: o.hint, address: 'a' });
  assert.equal(again.claims, 2);
  assert.equal(sendA('AAAA').ok, false);
  assert.equal(sendB('BBBB', 1).ok, false, 'a Host answering the old claim is refused');
  assert.deepEqual(rv.read({ id: o.id, ticket: o.ticket, after: 0 }), { ok: true, claims: 2, messages: [], expiresAt: o.expiresAt });
  assert.deepEqual(sendB('BBBB', 2), { ok: true, n: 1 });
  assert.equal(rv.close({ id: o.id, ticket: again.ticket }), true, 'either side may end it');
  assert.equal(rv.close({ id: o.id, ticket: again.ticket }), false);
});

test('an offer with no claim takes no message, an offer’s mailbox answers only so many requests a second, and expiry ends everything at once', () => {
  const { rv, clock } = mk({ perOfferBurst: 3, perOfferPerSecond: 1 });
  const o = offerOf(rv);
  assert.equal(rv.send({ id: o.id, ticket: o.ticket, claims: 0, box: 'AAAA' }).ok, false, 'nobody has claimed it');
  const limited = mk({ perOfferBurst: 2, perOfferPerSecond: 1 });
  const p = offerOf(limited.rv);
  const c = limited.rv.claim({ hint: p.hint, address: 'a' });
  assert.equal(limited.rv.send({ id: p.id, ticket: c.ticket, claims: 1, box: 'AAAA' }).ok, true);
  assert.equal(limited.rv.read({ id: p.id, ticket: p.ticket, after: 0 }).ok, true);
  assert.deepEqual(limited.rv.read({ id: p.id, ticket: p.ticket, after: 0 }), { ok: false, reason: 'limited' });
  assert.deepEqual(limited.rv.send({ id: p.id, ticket: p.ticket, claims: 1, box: 'AAAA' }), { ok: false, reason: 'limited' });
  clock.advance(OFFER_MS);
  assert.equal(rv.read({ id: o.id, ticket: o.ticket, after: 0 }).ok, false);
  rv.sweep();
  assert.equal(rv.size, 0);
});

test('nothing an exchange carries reaches the metrics: only counts', () => {
  const { rv, metrics } = mk();
  const o = offerOf(rv);
  const a = rv.claim({ hint: o.hint, address: 'a' });
  rv.send({ id: o.id, ticket: a.ticket, claims: 1, box: 'SEALEDBYTES' });
  rv.sweep();
  const text = metrics.render();
  for (const secret of [o.id, o.hint, o.ticket, a.ticket, 'SEALEDBYTES']) assert.ok(!text.includes(secret));
  assert.match(text, /relay_rendezvous_live 1/);
  assert.match(text, /relay_rendezvous_offers 1/);
});

test('one IPv6 /48 cannot throttle the callers that come after it: its /64s make no bucket past its own limit, and a full table pools new callers by shard, after dropping what refilled', () => {
  const { rv } = mk();
  const before = rv.buckets.reduce((a: number, b: number) => a + b, 0);
  for (let i = 0; i < 20_000; i++) rv.claim({ hint: 'AAA', address: `2001:db8:77:${i.toString(16)}::1` });
  const grown = rv.buckets.reduce((a: number, b: number) => a + b, 0) - before;
  assert.ok(grown <= 2 * 8 * LIMITS.claimsPerMinute + 10, `20,000 /64s of one /48 made ${grown} buckets`);
  // a fresh caller still has its whole budget, on IPv4 and on another /48
  for (const address of ['198.51.100.9', '2001:db8:78:1::1']) {
    let taken = 0;
    for (let i = 0; i < LIMITS.claimsPerMinute; i++) if (rv.claim({ hint: 'AAA', address }) !== 'limited') taken++;
    assert.equal(taken, LIMITS.claimsPerMinute, `${address} was held`);
  }
  // a table that is full drops the buckets that refilled before it shares: callers after a quiet minute get their own again
  const small = mk({ bucketCap: 20, claimsPerMinute: 2 });
  for (let i = 0; i < 40; i++) small.rv.claim({ hint: 'AAA', address: `10.0.0.${i}` });
  small.clock.advance(120_000);
  assert.notEqual(small.rv.claim({ hint: 'AAA', address: '10.9.9.9' }), 'limited');
  assert.notEqual(small.rv.claim({ hint: 'AAA', address: '10.9.9.9' }), 'limited');
  assert.equal(small.rv.claim({ hint: 'AAA', address: '10.9.9.9' }), 'limited', 'its own bucket of two, not a shared one');
  // callers a full table cannot hold share a few buckets by their key: some pass while one shard is spent
  const flood = mk({ bucketCap: 5, claimsPerMinute: 1, claimsPerHour: 1000 });
  for (let i = 0; i < 5; i++) flood.rv.claim({ hint: 'AAA', address: `10.1.0.${i}` });
  const passed = Array.from({ length: 200 }, (_, i) => flood.rv.claim({ hint: 'AAA', address: `10.2.${i}.1` })).filter(
    (r) => r !== 'limited',
  ).length;
  assert.ok(passed >= 10 && passed <= 30, `${passed} passed: about one a shard`);
});

test('a full table is scanned for refilled buckets at most once a second, and then a new key has a bucket of its own and the table is smaller', () => {
  const { rv, clock } = mk({ bucketCap: 20, claimsPerMinute: 2, claimsPerHour: 1000 });
  const size = () => rv.buckets[2];
  for (let i = 0; i < 20; i++) rv.claim({ hint: 'AAA', address: `10.0.0.${i}` });
  assert.equal(size(), 20, 'the table is full');
  assert.equal(rv.scans, 0);
  // full and nothing refilled yet: a new key is pooled, and the scans in one second are one
  rv.claim({ hint: 'AAA', address: '10.1.0.1' });
  rv.claim({ hint: 'AAA', address: '10.1.0.2' });
  rv.claim({ hint: 'AAA', address: '10.1.0.3' });
  assert.ok(rv.scans <= 3, `the three limits made ${rv.scans} scans for three calls in one second`);
  const first = rv.scans;
  rv.claim({ hint: 'AAA', address: '10.1.0.4' });
  assert.equal(rv.scans, first, 'a second call within the second scans nothing');
  assert.equal(size(), 20, 'nothing had refilled, so nothing was dropped');
  // a minute on, the buckets are full again: the next new key scans once, the table shrinks, and the key has a bucket of its own
  clock.advance(120_000);
  rv.claim({ hint: 'AAA', address: '10.2.0.1' });
  assert.ok(rv.scans > first);
  assert.equal(size(), 1, 'only the new key’s bucket is left');
  const own = [rv.claim({ hint: 'AAA', address: '10.2.0.1' }), rv.claim({ hint: 'AAA', address: '10.2.0.1' })];
  assert.deepEqual(
    own.map((r: any) => r === 'limited'),
    [false, true],
    'its own bucket of two, not a pooled one',
  );
  const again = rv.scans;
  rv.claim({ hint: 'AAA', address: '10.2.0.2' });
  rv.claim({ hint: 'AAA', address: '10.2.0.3' });
  assert.equal(rv.scans, again, 'a table with room is not scanned');
});

test('an address written as IPv6 that holds an IPv4 one is that IPv4 address, in every spelling', () => {
  for (const form of [
    '::ffff:1.2.3.4',
    '::FFFF:0102:0304',
    '0:0:0:0:0:ffff:1.2.3.4',
    '0000:0000:0000:0000:0000:ffff:0102:0304',
    '::1.2.3.4',
    '::ffff:1.2.3.4%lo',
  ]) {
    assert.deepEqual(callerOf(form), { primary: '1.2.3.4', wide: null }, form);
  }
  assert.equal(callerOf('::1').wide, '0000:0000:0000/48', '::1 and :: are IPv6 addresses');
  assert.equal(callerOf('::').wide, '0000:0000:0000/48');
  assert.equal(callerOf('::0.0.0.1').wide, '0000:0000:0000/48');
  for (const bad of ['999.1.1.1', '1.2.3.4.5', '::ffff:999.1.1.1', '2001:db8::1.2.3.256']) assert.equal(callerOf(bad).wide, null, bad);
  assert.equal(callerOf('2001:db8::1.2.3.4').wide, '2001:0db8:0000/48', 'a dotted tail in a real IPv6 address is read');
});

test('the table of mailbox buckets holds at most the live offers, and an offer’s place goes with it', () => {
  const { rv } = mk({ live: 4, perAccount: 10, offersPerHour: 100 });
  const made = Array.from({ length: 4 }, (_, i) => offerOf(rv, `u${i}`, `10.0.0.${i}`));
  for (const o of made) rv.read({ id: o.id, ticket: o.ticket, after: 0 });
  const mailboxes = () => rv.buckets[6];
  assert.equal(mailboxes(), 4);
  assert.deepEqual(rv.offer({ account: 'x', address: '10.9.9.9' }), { ok: false, reason: 'busy' });
  rv.close({ id: made[0].id, ticket: made[0].ticket });
  assert.equal(mailboxes(), 3);
  const next = offerOf(rv, 'y', '10.9.9.8');
  rv.read({ id: next.id, ticket: next.ticket, after: 0 });
  assert.equal(mailboxes(), 4, 'never more than the live offers');
});

test('a claimant that was replaced is nothing: its read, send and close are the uniform refusal, and it learns nothing of the new claim', () => {
  const { rv } = mk(wide);
  const o = offerOf(rv);
  const first = rv.claim({ hint: o.hint, address: 'a' });
  const second = rv.claim({ hint: o.hint, address: 'b' });
  assert.notEqual(first.ticket, second.ticket, 'a new claim has a new ticket');
  assert.deepEqual(rv.read({ id: o.id, ticket: first.ticket, after: 0 }), { ok: false, reason: 'gone' });
  assert.deepEqual(rv.send({ id: o.id, ticket: first.ticket, claims: first.claims, box: 'AAAA' }), { ok: false, reason: 'gone' });
  assert.deepEqual(rv.send({ id: o.id, ticket: first.ticket, claims: second.claims, box: 'AAAA' }), { ok: false, reason: 'gone' });
  assert.equal(rv.close({ id: o.id, ticket: first.ticket }), false);
  // and the new claimant's still works, so the refusal was about the ticket
  assert.equal(rv.send({ id: o.id, ticket: second.ticket, claims: second.claims, box: 'AAAA' }).ok, true);
  assert.equal(rv.close({ id: o.id, ticket: second.ticket }), true);
});

// ---- over HTTP, through the relay's own server ----
const keys = await makeKeys();
const { db } = await makeDb();
const closing: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closing) await close();
});
async function serve(env: Record<string, string> = { RENDEZVOUS: '1' }) {
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused', ...env });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  closing.push(() => relay.close());
  const call = async (path: string, json: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/rendezvous/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof json === 'string' ? json : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { relay, port, call };
}

test('over HTTP: an account makes an offer, anyone claims its hint, the two sides exchange and close; every refusal about a code is one 404', async () => {
  const { call, port, relay } = await serve();
  const token = await keys.sign('u1', 'dev1');
  const offer = await call('offer', {}, token);
  assert.equal(offer.status, 200);
  assert.deepEqual(Object.keys(offer.json).sort(), ['expiresAt', 'hint', 'id', 'ticket']);
  assert.equal(offer.headers.get('cache-control'), 'no-store');
  const claim = await call('claim', { hint: offer.json.hint.toLowerCase() });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.id, offer.json.id);
  assert.equal((await call(`${offer.json.id}/send`, { ticket: claim.json.ticket, claims: claim.json.claims, box: 'AAAA' })).status, 200);
  const read = (await call(`${offer.json.id}/read`, { ticket: offer.json.ticket, after: 0 })).json;
  assert.deepEqual([read.claims, read.messages], [1, [{ n: 1, box: 'AAAA' }]]);
  // the same 404 for an unknown hint, a wrong ticket, an unknown id, a stale claim and a closed offer
  const gone = [
    await call('claim', { hint: 'ZZZ' }),
    await call(`${offer.json.id}/read`, { ticket: 'x'.repeat(22) }),
    await call('r_AAAAAAAAAAAAAAAAAAAAAA/read', { ticket: offer.json.ticket }),
    await call(`${offer.json.id}/send`, { ticket: offer.json.ticket, claims: 9, box: 'BBBB' }),
  ];
  assert.equal((await call(`${offer.json.id}/send`, { ticket: offer.json.ticket, claims: 1, box: 'BBBB' })).status, 200);
  assert.deepEqual((await call(`${offer.json.id}/send`, { ticket: offer.json.ticket, claims: 1, box: 'BBBC' })).json, { error: 'wait' });
  assert.equal((await call(`${offer.json.id}/close`, { ticket: offer.json.ticket })).status, 204);
  gone.push(await call(`${offer.json.id}/read`, { ticket: offer.json.ticket }), await call('claim', { hint: offer.json.hint }));
  for (const g of gone) assert.deepEqual([g.status, g.json], [404, { error: 'no_such_code' }]);
  // an offer needs an account or a Host's credential; the others need no account
  assert.equal((await call('offer', {})).status, 401);
  assert.equal((await call('offer', {}, 'mh1.nope.nope')).status, 401);
  assert.equal((await call('offer', {}, await keys.sign('u1', 'dev1', { aud: 'wrong' }))).status, 401);
  // not a POST, a body that is not an object, one too large, a path that is not a route
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/rendezvous/claim`)).status, 405);
  assert.equal((await call('claim', '[1]')).status, 400);
  assert.equal((await call('claim', 'nope')).status, 400);
  assert.equal((await call('claim', { hint: 'AAA', pad: 'x'.repeat(5000) })).status, 400);
  assert.equal((await call('whatever', {})).status, 404);
  assert.equal(relay.hub.rendezvous?.size, 0);
});

test('over HTTP: it is off unless RENDEZVOUS=1, and then every path answers like one the relay does not have', async () => {
  for (const env of [{}, { RENDEZVOUS: '0' }, { RENDEZVOUS: 'true' }] as Record<string, string>[]) {
    const { call, relay, port } = await serve(env);
    assert.equal(relay.hub.rendezvous, null, 'the service is not even made');
    const token = await keys.sign('u1', 'dev1');
    const off = [await call('offer', {}, token), await call('claim', { hint: 'AAA' }), await call('r_AAAAAAAAAAAAAAAAAAAAAA/read', {})];
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/nothing-here`, { method: 'POST' });
    for (const r of off) assert.equal(r.status, unknown.status);
    assert.equal(unknown.status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/rendezvous/offer`)).status, 404, 'not even a 405 that would say it exists');
  }
});

test('over HTTP: a page in a browser cannot use it, a switched-off account cannot offer, and the limits and the bound answer with their own status', async () => {
  const { call, relay, port } = await serve();
  const token = await keys.sign('u5', 'dev5');
  // an Origin is refused, whatever it says; a body that is not JSON is refused; a preflight is 405
  assert.deepEqual((await call('claim', { hint: 'AAA' }, undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('offer', {}, token, { origin: 'null' })).status, 403);
  assert.equal((await call('claim', { hint: 'AAA' }, undefined, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('claim', { hint: 'AAA' }, undefined, { 'content-type': 'application/json; charset=utf-8' })).status, 404);
  const pre = await fetch(`http://127.0.0.1:${port}/v1/rendezvous/claim`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [405, null]);
  // a switched-off account (its token issued before it was switched off) cannot offer
  await relay.store.disableAccount('u5', Date.now() + 60_000);
  const off = await call('offer', {}, token);
  assert.deepEqual([off.status, off.json], [403, { error: 'disabled' }]);
  // a Host credential that keeps failing is limited before anything is asked
  const bad = `mh1.h_${'A'.repeat(20)}.${'B'.repeat(43)}`;
  const seen = new Set<number>();
  let last = null as any;
  for (let i = 0; i < 40; i++) seen.add((last = await call('offer', {}, bad)).status);
  assert.deepEqual([...seen].sort(), [401, 429]);
  assert.equal(last.headers.get('retry-after'), '10');
  // a full relay says busy; an account at its offers says so; an empty body is read as empty
  relay.hub.rendezvous = createRendezvous({ limits: { ...LIMITS, live: 1 } }) as any;
  const first = await call('offer', {}, await keys.sign('u7', 'dev7'));
  assert.equal(first.status, 200);
  const busy = await call('offer', {}, await keys.sign('u8', 'dev8'));
  assert.deepEqual([busy.status, busy.json, busy.headers.get('retry-after')], [503, { error: 'busy' }, '30']);
  assert.deepEqual((await call(`${first.json.id}/close`, { ticket: 'x'.repeat(22) })).json, { error: 'no_such_code' });
  assert.equal(
    (await call(`${first.json.id}/read`, '')).json?.error,
    'no_such_code',
    'an empty body is an empty object: no ticket, no such code',
  );
  // a flooded mailbox is told to wait
  const reads: any[] = [];
  for (let i = 0; i < 100; i++) reads.push(await call(`${first.json.id}/read`, { ticket: first.json.ticket }));
  const flooded = reads.find((r) => r.status === 429);
  assert.deepEqual([flooded?.status, flooded?.json, flooded?.headers.get('retry-after')], [429, { error: 'limited' }, '2']);
  // the account limit and a claim flood
  relay.hub.rendezvous = createRendezvous({ limits: { ...LIMITS, perAccount: 1, claimsPerMinute: 2 } }) as any;
  const tokenB = await keys.sign('u9', 'dev9');
  assert.equal((await call('offer', {}, tokenB)).status, 200);
  const over = await call('offer', {}, tokenB);
  assert.deepEqual([over.status, over.json, over.headers.get('retry-after')], [429, { error: 'account_limit' }, '30']);
  const claims: number[] = [];
  for (let i = 0; i < 4; i++) claims.push((await call('claim', { hint: 'AAA' })).status);
  assert.deepEqual(claims, [404, 404, 429, 429]);
  // a message that does not fit, or a full mailbox, are told apart from a missing offer
  relay.hub.rendezvous = createRendezvous() as any;
  const o = (await call('offer', {}, await keys.sign('u10', 'dev10'))).json;
  const a = (await call('claim', { hint: o.hint })).json;
  assert.equal((await call(`${o.id}/send`, { ticket: a.ticket, claims: 1, box: 'not valid!' })).status, 400);
  for (let i = 0; i < MAX_MESSAGES; i++) await call(`${o.id}/send`, { ticket: i % 2 ? a.ticket : o.ticket, claims: 1, box: 'AAAA' });
  assert.deepEqual((await call(`${o.id}/send`, { ticket: o.ticket, claims: 1, box: 'AAAA' })).json, { error: 'full' });
});

test('the relay’s own timer tick sweeps the offers that ran out, and does nothing when the service is off', async () => {
  const on = await serve();
  const token = await keys.sign('u1', 'dev1');
  const made = await on.call('offer', {}, token);
  assert.equal(made.status, 200);
  // the tick is the timer's work: it drops what ran out
  const rv = on.relay.hub.rendezvous as any;
  assert.equal(rv.size, 1);
  on.relay.hub.tick();
  assert.equal(rv.size, 1, 'a live offer stays');
  const off = await serve({});
  off.relay.hub.tick();
  assert.equal(off.relay.hub.rendezvous, null);
});
