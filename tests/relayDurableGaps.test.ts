// Counters the durable store's high-water mark jumped over (relay/src/durableStore.mjs gaps, #3215): a frame for one is stored, not answered "consumed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pairedDurableStore } from './helpers/relayDurableFixture';

const frame = (epoch: string, ctr: number, o: object = {}) => ({
  pairId: 'p_test0001',
  epoch,
  dir: 'm2p',
  ctr,
  nonce: Buffer.alloc(24),
  box: Buffer.from([ctr]),
  sender: 'mac',
  userId: 'u',
  maxFrames: 10,
  maxBytes: 1000,
  now: 1000,
  ttlMs: 60_000,
  ...o,
});
const receiver = (epoch: string, o: object = {}) => ({
  pairId: 'p_test0001',
  epoch,
  userId: 'u',
  receiver: 'phone',
  dir: 'm2p',
  now: 1000,
  ...o,
});

async function withStore(fn: (store: any, epoch: string, db: PGlite) => Promise<void>) {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    await fn(store, epoch, db);
  } finally {
    await db.close();
  }
}
const gaps = async (db: PGlite) =>
  (await db.query<any>('SELECT lo, hi FROM remote_durable.gaps ORDER BY lo')).rows.map((r) => [Number(r.lo), Number(r.hi)]);
const ctrs = async (store: any, epoch: string) =>
  (await store.deliverable(receiver(epoch, { afterCtr: 0, limit: 10 }))).frames.map((f: any) => Number(f.ctr));

test('a frame refused as mailbox_full and resent after a later one was stored is stored, and delivered in counter order', async () => {
  await withStore(async (store, epoch, db) => {
    assert.equal((await store.enqueue(frame(epoch, 1))).code, 'stored');
    assert.equal((await store.enqueue(frame(epoch, 2, { maxFrames: 1 }))).code, 'full');
    assert.equal((await store.enqueue(frame(epoch, 3))).code, 'stored');
    assert.deepEqual(await gaps(db), [[2, 2]]);
    assert.equal((await store.enqueue(frame(epoch, 2))).code, 'stored', 'not "expired" (which the hub acknowledges as consumed)');
    assert.deepEqual(await gaps(db), []);
    assert.deepEqual(await ctrs(store, epoch), [1, 2, 3]);
    assert.equal((await store.enqueue(frame(epoch, 2))).code, 'duplicate');
  });
});

test('a gap is split around each late frame, and a late frame is still checked against the mailbox limits', async () => {
  await withStore(async (store, epoch, db) => {
    await store.enqueue(frame(epoch, 1));
    await store.enqueue(frame(epoch, 6));
    assert.deepEqual(await gaps(db), [[2, 5]]);
    assert.equal((await store.enqueue(frame(epoch, 4))).code, 'stored');
    assert.deepEqual(await gaps(db), [
      [2, 3],
      [5, 5],
    ]);
    assert.equal((await store.enqueue(frame(epoch, 2))).code, 'stored');
    assert.deepEqual(await gaps(db), [
      [3, 3],
      [5, 5],
    ]);
    assert.equal((await store.enqueue(frame(epoch, 5, { maxFrames: 4 }))).code, 'full');
    assert.equal((await store.enqueue(frame(epoch, 5, { relayFull: true }))).code, 'full');
    assert.deepEqual(await gaps(db), [
      [3, 3],
      [5, 5],
    ]);
    assert.equal((await store.enqueue(frame(epoch, 7))).code, 'stored', 'a next counter adds no gap');
    assert.deepEqual(await ctrs(store, epoch), [1, 2, 4, 6, 7]);
  });
});

test('a counter the mark did not jump over, or one behind a later acknowledgement, is still answered expired', async () => {
  await withStore(async (store, epoch, db) => {
    const one = await store.enqueue(frame(epoch, 1));
    await store.enqueue(frame(epoch, 2));
    assert.equal((await store.ack({ ...receiver(epoch), ctr: 1, id: one.id })).code, 'acked');
    assert.equal((await store.enqueue(frame(epoch, 1))).code, 'expired', 'acknowledged and gone');
    await store.enqueue(frame(epoch, 5));
    await store.enqueue(frame(epoch, 9));
    assert.deepEqual(await gaps(db), [
      [3, 4],
      [6, 8],
    ]);
    // the receiver acknowledged 5: it can no longer open 3 or 4, so they are gone
    assert.equal((await store.ackByCtr(receiver(epoch, { ctr: 5 }))).code, 'acked');
    assert.deepEqual(await gaps(db), [[6, 8]]);
    assert.equal((await store.enqueue(frame(epoch, 3))).code, 'expired');
    const nine = (await store.deliverable(receiver(epoch, { afterCtr: 5, limit: 1 }))).frames[0];
    assert.equal((await store.ack({ ...receiver(epoch), ctr: 9, id: nine.id })).code, 'acked');
    assert.deepEqual(await gaps(db), []);
    assert.equal((await store.enqueue(frame(epoch, 7))).code, 'expired');
  });
});

test('a gap goes with its pair', async () => {
  await withStore(async (store, epoch, db) => {
    await store.enqueue(frame(epoch, 1));
    await store.enqueue(frame(epoch, 4));
    await db.query("DELETE FROM relay_pairs WHERE pair_id = 'p_test0001'");
    assert.deepEqual(await gaps(db), []);
  });
});

for (const [dir, sender, rcv] of [
  ['m2p', 'mac', 'phone'],
  ['p2m', 'phone', 'mac'],
] as const) {
  test(`${dir}: a first frame refused on a cold stream and resent after counter 2 was stored is stored (#3762)`, async () => {
    await withStore(async (store, epoch, db) => {
      const f = (ctr: number, o: object = {}) => frame(epoch, ctr, { dir, sender, ...o });
      assert.equal((await store.enqueue(f(1, { relayFull: true }))).code, 'full');
      assert.equal((await store.enqueue(f(2))).code, 'stored');
      assert.deepEqual(await gaps(db), [[1, 1]]);
      assert.equal((await store.enqueue(f(1))).code, 'stored', 'never stored or acknowledged, so not "expired"');
      assert.deepEqual(await gaps(db), []);
      assert.equal((await store.enqueue(f(5))).code, 'stored');
      assert.deepEqual(await gaps(db), [[3, 4]]);
      assert.equal((await store.ackByCtr(receiver(epoch, { dir, receiver: rcv, ctr: 5 }))).code, 'acked');
      assert.equal((await store.enqueue(f(3))).code, 'expired');
    });
  });
}
