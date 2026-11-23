// relay/src/store.mjs against a real Postgres (PGlite): pairs and who may join, the capped mailbox, TTL sweeps with drop notices, push tokens and revocation.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../relay/src/store.mjs';
import { makeDb } from './support/relayKit.ts';

const { db, reset } = await makeDb();
const store = new Store(db as any);
const T0 = Date.UTC(2030, 0, 1);
const box = (n: number, fill = 1) => Buffer.alloc(n, fill);
const frame = (o: object = {}) => ({
  pairId: 'p_one',
  dir: 'm2p',
  ctr: 1,
  nonce: box(24),
  box: box(10),
  now: T0,
  ttlMs: 1000,
  maxFrames: 10,
  maxBytes: 1000,
  ...o,
});

beforeEach(async () => {
  await reset();
  await store.registerPair({ pairId: 'p_one', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 });
});

test('a pending pair is re-registerable by its Mac until a phone joins, never by anyone else', async () => {
  assert.equal(await store.registerPair({ pairId: 'p_one', userId: 'u1', macDeviceId: 'mac1', now: T0 + 5, joinMs: 1000 }), true);
  assert.equal(await store.registerPair({ pairId: 'p_one', userId: 'u2', macDeviceId: 'mac1', now: T0, joinMs: 1000 }), false);
  assert.equal(await store.registerPair({ pairId: 'p_one', userId: 'u1', macDeviceId: 'mac2', now: T0, joinMs: 1000 }), false);
  assert.deepEqual(await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 + 10 }), {
    ok: true,
    macDeviceId: 'mac1',
  });
  assert.equal(await store.registerPair({ pairId: 'p_one', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 }), false);
});

test('joining: same account, before the deadline, one phone; the same phone may rejoin', async () => {
  assert.deepEqual(await store.joinPair({ pairId: 'p_none', userId: 'u1', phoneDeviceId: 'ph1', now: T0 }), {
    ok: false,
    code: 'unknown_pair',
  });
  assert.deepEqual(await store.joinPair({ pairId: 'p_one', userId: 'u2', phoneDeviceId: 'ph1', now: T0 }), {
    ok: false,
    code: 'forbidden',
  });
  assert.deepEqual(await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 + 1000 }), {
    ok: false,
    code: 'expired',
  });
  assert.equal((await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 + 999 })).ok, true);
  assert.equal((await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 + 99999 })).ok, true);
  assert.deepEqual(await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph2', now: T0 }), { ok: false, code: 'taken' });
});

test('lookups by device and Mac, and removing a pair takes its mailbox with it', async () => {
  await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 });
  await store.registerPair({ pairId: 'p_two', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 });
  assert.deepEqual(
    (await store.pairsForDevice('mac1')).map((p) => [p.pairId, p.phoneDeviceId]),
    [
      ['p_one', 'ph1'],
      ['p_two', null],
    ],
  );
  assert.deepEqual(
    (await store.pairsForDevice('ph1')).map((p) => p.pairId),
    ['p_one'],
  );
  assert.deepEqual(
    (await store.phonesOfMac('mac1')).map((p) => p.pairId),
    ['p_one'],
  );
  assert.equal((await store.getPair('p_one'))!.userId, 'u1');
  assert.equal(await store.getPair('p_zzz'), null);
  await store.enqueue(frame());
  assert.equal(await store.removePair('p_one'), true);
  assert.equal(await store.removePair('p_one'), false);
  assert.deepEqual(await store.waiting('p_one', 'm2p', 10), []);
});

test('the mailbox keeps arrival order per direction and deletes what was delivered', async () => {
  for (const ctr of [1, 2, 3]) await store.enqueue(frame({ ctr, box: box(5, ctr) }));
  await store.enqueue(frame({ dir: 'p2m', ctr: 9 }));
  const got = await store.waiting('p_one', 'm2p', 2);
  assert.deepEqual(
    got.map((f) => f.ctr),
    [1, 2],
  );
  assert.ok(Buffer.isBuffer(got[0].box) && got[0].box.equals(box(5, 1)));
  assert.equal(got[0].nonce.length, 24);
  await store.deleteFrames(got.map((f) => f.id));
  assert.deepEqual(
    (await store.waiting('p_one', 'm2p', 10)).map((f) => f.ctr),
    [3],
  );
  assert.deepEqual(
    (await store.waiting('p_one', 'p2m', 10)).map((f) => f.ctr),
    [9],
  );
  await store.deleteFrames([]);
});

test('a full mailbox refuses by frame count and by bytes, per pair', async () => {
  assert.equal(await store.enqueue(frame({ maxFrames: 2 })), true);
  assert.equal(await store.enqueue(frame({ maxFrames: 2, ctr: 2 })), true);
  assert.equal(await store.enqueue(frame({ maxFrames: 2, ctr: 3 })), false);
  await reset();
  await store.registerPair({ pairId: 'p_one', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 });
  assert.equal(await store.enqueue(frame({ box: box(60), maxBytes: 100 })), true);
  assert.equal(await store.enqueue(frame({ box: box(41), maxBytes: 100, ctr: 2 })), false);
  assert.equal(await store.enqueue(frame({ box: box(40), maxBytes: 100, ctr: 3 })), true);
  await store.registerPair({ pairId: 'p_two', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 });
  assert.equal(await store.enqueue(frame({ pairId: 'p_two', box: box(100), maxBytes: 100 })), true);
});

test('past the TTL, frames are dropped and one notice per pair and direction records how many and which counters', async () => {
  await store.enqueue(frame({ ctr: 4, ttlMs: 1000 }));
  await store.enqueue(frame({ ctr: 5, ttlMs: 1000 }));
  await store.enqueue(frame({ ctr: 6, ttlMs: 9000 }));
  await store.enqueue(frame({ dir: 'p2m', ctr: 1, ttlMs: 1000 }));
  assert.deepEqual(await store.sweepExpired(T0 + 999), []);
  const drops = (await store.sweepExpired(T0 + 1000)).sort((a, b) => a.dir.localeCompare(b.dir));
  assert.deepEqual(drops, [
    { pairId: 'p_one', dir: 'm2p', dropped: 2, firstCtr: 4, lastCtr: 5 },
    { pairId: 'p_one', dir: 'p2m', dropped: 1, firstCtr: 1, lastCtr: 1 },
  ]);
  assert.deepEqual(
    (await store.waiting('p_one', 'm2p', 10)).map((f) => f.ctr),
    [6],
  );
  assert.deepEqual(await store.takeDrops('p_one', 'm2p'), [drops[0]]);
  assert.deepEqual(await store.takeDrops('p_one', 'm2p'), []);
});

test('a push token belongs to one device, and one token is never held by two devices', async () => {
  const set = (deviceId: string, token: string, platform = 'apns') =>
    store.setPushToken({ deviceId, userId: 'u1', platform, token, now: T0 });
  assert.equal(await store.pushTokenOf('ph1'), null);
  await set('ph1', 'tok-a');
  await set('ph1', 'tok-b', 'fcm');
  assert.deepEqual(await store.pushTokenOf('ph1'), { platform: 'fcm', token: 'tok-b' });
  await set('ph2', 'tok-b');
  assert.equal(await store.pushTokenOf('ph1'), null);
  assert.deepEqual(await store.pushTokenOf('ph2'), { platform: 'apns', token: 'tok-b' });
  await store.deletePushToken('ph2');
  assert.equal(await store.pushTokenOf('ph2'), null);
});

test('revoking a device remembers it, drops its token and its pairs, and names the peers', async () => {
  await store.joinPair({ pairId: 'p_one', userId: 'u1', phoneDeviceId: 'ph1', now: T0 });
  await store.registerPair({ pairId: 'p_two', userId: 'u1', macDeviceId: 'mac1', now: T0, joinMs: 1000 });
  await store.setPushToken({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 't', now: T0 });
  await store.enqueue(frame());
  assert.equal(await store.isRevoked('ph1'), false);
  const hit = ((await store.revokeDevice({ deviceId: 'ph1', userId: 'u1', now: T0 })) ?? []).sort((a, b) =>
    a.pairId.localeCompare(b.pairId),
  );
  assert.deepEqual(hit, [{ pairId: 'p_one', peerDeviceId: 'mac1' }]);
  assert.equal(await store.isRevoked('ph1'), true);
  assert.equal(await store.pushTokenOf('ph1'), null);
  assert.deepEqual(await store.waiting('p_one', 'm2p', 10), []);
  // a Mac: its pending pair has no peer
  assert.deepEqual(await store.revokeDevice({ deviceId: 'mac1', userId: 'u1', now: T0 }), [{ pairId: 'p_two', peerDeviceId: null }]);
  assert.deepEqual(await store.revokeDevice({ deviceId: 'mac1', userId: 'u1', now: T0 }), []);
});
