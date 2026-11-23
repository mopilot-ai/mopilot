// The durable store's receiver-side operations the hub uses (relay/src/durableStore.mjs): deliverable by counter, ack by counter, due expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pairedDurableStore } from './helpers/relayDurableFixture';

const base = (epoch: string, ctr: number) => ({
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
  ttlMs: 5000,
});
const to = (epoch: string, o: object = {}) => ({
  pairId: 'p_test0001',
  epoch,
  userId: 'u',
  receiver: 'phone',
  dir: 'm2p',
  now: 1000,
  ...o,
});

test('deliverable returns live frames after a counter in order and checks its inputs, receiver and epoch', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    for (const n of [1, 2, 3]) await store.enqueue(base(epoch, n));
    await store.enqueue({ ...base(epoch, 4), ttlMs: 1 });
    const live = await store.deliverable(to(epoch, { afterCtr: 1, limit: 5, now: 2000 }));
    assert.deepEqual(
      live.frames.map((f: any) => Number(f.ctr)),
      [2, 3],
    );
    assert.equal((await store.deliverable(to(epoch, { afterCtr: 0, limit: 1 }))).frames.length, 1);
    assert.equal((await store.deliverable(to(epoch, { afterCtr: 0, limit: 0 }))).code, 'invalid');
    assert.equal((await store.deliverable(to(epoch, { afterCtr: 0, limit: 1, now: 'x' }))).code, 'invalid');
    assert.equal((await store.deliverable(to(epoch, { afterCtr: 0, limit: 1, receiver: 'mac' }))).code, 'forbidden');
    assert.equal((await store.deliverable(to('00000000-0000-4000-8000-000000000000', { afterCtr: 0, limit: 1 }))).code, 'retired');
  } finally {
    await db.close();
  }
});

test('ackByCtr removes exactly the named frame, once; an expired one is left for the sweep', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    await store.enqueue(base(epoch, 1));
    await store.enqueue(base(epoch, 2));
    await store.enqueue({ ...base(epoch, 3), ttlMs: 1 });
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 0 }))).code, 'invalid');
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 1, now: 'x' }))).code, 'invalid');
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 1, receiver: 'mac' }))).code, 'forbidden');
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 1 }))).code, 'acked');
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 1 }))).code, 'gone');
    assert.equal((await store.ackByCtr(to(epoch, { ctr: 3, now: 9000 }))).code, 'expired');
    assert.equal((await store.ackByCtr(to('00000000-0000-4000-8000-000000000000', { ctr: 2 }))).code, 'retired');
    assert.equal((await db.query('SELECT 1 FROM remote_durable.frames')).rows.length, 2);
  } finally {
    await db.close();
  }
});

test('dueExpiry names the pairs with a frame past its TTL, with their epoch', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    await store.enqueue(base(epoch, 1));
    assert.deepEqual(await store.dueExpiry(2000), []);
    assert.deepEqual(await store.dueExpiry(6000), [{ pairId: 'p_test0001', epoch }]);
    assert.deepEqual(await store.dueExpiry('x'), []);
  } finally {
    await db.close();
  }
});
