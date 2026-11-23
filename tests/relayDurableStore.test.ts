// Durable relay store uses real PostgreSQL semantics through PGlite for replay and capacity contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../relay/src/schema.mjs';
import { pairedDurableStore } from './helpers/relayDurableFixture';
const require = createRequire(import.meta.url);

test('serialized PGlite transactions enforce pair capacity and exact retries are idempotent', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const frame = (ctr: number) => ({
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr,
      nonce: Buffer.alloc(24),
      box: Buffer.from([ctr]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 1,
      maxBytes: 100,
      now: Date.now(),
      ttlMs: 60000,
    });
    const [a, b] = await Promise.all([store.enqueue(frame(1)), store.enqueue(frame(2))]);
    assert.deepEqual([a.code, b.code].sort(), ['full', 'stored']);
    assert.equal((await store.enqueue(frame(1))).code, 'duplicate');
    assert.equal((await store.enqueue({ ...frame(1), box: Buffer.from([9]) })).code, 'conflict');
  } finally {
    await db.close();
  }
});

test('only the current recipient can acknowledge an exact frame; consumed counters never revive', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const frame = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 2,
      maxBytes: 100,
      now: Date.now(),
      ttlMs: 60000,
    };
    const added = await store.enqueue(frame);
    const ack = { pairId: frame.pairId, epoch, userId: 'u', receiver: 'phone', dir: frame.dir, ctr: 1, id: added.id, now: frame.now };
    assert.equal((await store.ack({ ...ack, receiver: 'mac' })).code, 'forbidden');
    assert.equal((await store.ack({ ...ack, userId: 'other' })).code, 'forbidden');
    assert.equal((await store.ack({ ...ack, ctr: 2 })).code, 'gone');
    assert.equal((await store.waiting(ack)).frames.length, 1);
    assert.equal((await store.ack(ack)).code, 'acked');
    assert.equal((await store.ack(ack)).code, 'gone');
    assert.equal((await store.enqueue(frame)).code, 'expired');
    await db.query('DELETE FROM relay_pairs WHERE pair_id = $1', [frame.pairId]);
    await db.query(
      "INSERT INTO relay_pairs (pair_id,user_id,mac_device_id,phone_device_id,join_deadline,created_at) VALUES ('p_test0001','u','mac','phone',now(),now())",
    );
    const replacement = (await store.openEpoch({ pairId: frame.pairId, userId: 'u', sender: 'mac' })).epoch;
    const next = await store.enqueue({ ...frame, epoch: replacement });
    assert.notEqual(next.id, added.id);
    assert.equal((await store.ack(ack)).code, 'retired');
    assert.equal((await store.waiting({ ...ack, epoch: replacement })).frames[0].id, next.id);
  } finally {
    await db.close();
  }
});

test('expiry records a durable notice and leaves the counter retired', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const frame = {
      pairId: 'p_test0001',
      epoch,
      dir: 'p2m',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'phone',
      userId: 'u',
      maxFrames: 2,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    assert.equal((await store.enqueue(frame)).code, 'stored');
    assert.deepEqual(await store.expire(frame.pairId, epoch, 1100), { code: 'ok', count: 1 });
    const notice = await store.drops({ pairId: frame.pairId, epoch, userId: 'u', sender: 'phone', dir: frame.dir });
    assert.equal(notice.drops.length, 1);
    const drop = { pairId: frame.pairId, epoch, userId: 'u', sender: 'phone', dir: frame.dir, id: notice.drops[0].id, ctr: 1 };
    assert.equal((await store.ackDrop({ ...drop, sender: 'mac' })).code, 'forbidden');
    assert.equal((await store.ackDrop(drop)).code, 'acked');
    assert.equal((await store.ackDrop(drop)).code, 'gone');
    assert.equal((await store.enqueue(frame)).code, 'expired');
  } finally {
    await db.close();
  }
});

test('invalid boundaries, ownership and byte capacity fail closed', async () => {
  const { migrateDurable, DurableStore } = require('../relay/src/durableStore.mjs');
  const db = new PGlite();
  try {
    await migrate(db);
    await migrateDurable(db);
    await db.query(
      "INSERT INTO relay_pairs (pair_id,user_id,mac_device_id,phone_device_id,join_deadline,created_at) VALUES ('p_test0001','u','mac','phone',now(),now()), ('p_pending1','u','mac',NULL,now(),now())",
    );
    const store = new DurableStore((fn: any) => db.transaction(fn));
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const f = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 5,
      maxBytes: 100,
      now: 1000,
      ttlMs: 5000,
    };
    for (const patch of [
      { dir: 'bad' },
      { ctr: 0 },
      { ctr: 1.5 },
      { nonce: 'bad' },
      { box: 'bad' },
      { nonce: Buffer.alloc(0) },
      { box: Buffer.alloc(0) },
      { nonce: Buffer.alloc(65) },
      { box: Buffer.alloc(262145) },
      { maxFrames: 0 },
      { maxFrames: 1.5 },
      { maxBytes: 0 },
      { maxBytes: 1.5 },
      { now: 1.5 },
      { ttlMs: 0 },
      { ttlMs: 1.5 },
      { now: Number.MAX_SAFE_INTEGER, ttlMs: 1 },
      { now: 8640000000000000, ttlMs: 1 },
    ])
      assert.equal((await store.enqueue({ ...f, ...patch })).code, 'invalid');
    for (const patch of [{ pairId: 'p_missing1' }, { pairId: 'p_pending1' }, { userId: 'other' }, { sender: 'phone' }])
      assert.equal((await store.enqueue({ ...f, ...patch })).code, 'forbidden');
    assert.equal((await store.enqueue({ ...f, maxBytes: 24 })).code, 'full');
    assert.equal((await store.enqueue({ ...f, dir: 'p2m', sender: 'phone' })).code, 'stored');
    assert.equal(
      (await store.waiting({ pairId: f.pairId, epoch, now: 1000, userId: 'u', receiver: 'phone', dir: 'p2m' })).code,
      'forbidden',
    );
    assert.equal((await store.waiting({ pairId: f.pairId, epoch, now: 1000, userId: 'u', receiver: 'mac', dir: 'p2m' })).frames.length, 1);
    assert.equal((await store.ack({})).code, 'invalid');
    assert.equal((await store.ackDrop({})).code, 'invalid');
    assert.equal((await store.expire(f.pairId, epoch, Number.NaN)).code, 'invalid');
    assert.equal((await store.expire('p_missing1', epoch, 1000)).code, 'gone');
    assert.equal((await store.drops({ pairId: f.pairId, epoch, userId: 'u', sender: 'mac', dir: 'p2m' })).code, 'forbidden');
  } finally {
    await db.close();
  }
});

test('new expiry notices invalidate an older acknowledgement without losing the update', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const f = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 5,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    await store.enqueue(f);
    await store.expire(f.pairId, epoch, 1100);
    const a = { pairId: f.pairId, epoch, userId: 'u', sender: 'mac', dir: 'm2p' };
    const old = (await store.drops(a)).drops[0];
    await store.enqueue({ ...f, ctr: 2 });
    await store.expire(f.pairId, epoch, 1100);
    assert.equal((await store.ackDrop({ ...a, id: old.id, ctr: 1 })).code, 'gone');
    const fresh = (await store.drops(a)).drops[0];
    assert.notEqual(fresh.id, old.id);
    assert.equal(Number(fresh.dropped), 2);
    assert.equal((await store.ackDrop({ ...a, id: fresh.id, ctr: 2 })).code, 'acked');
  } finally {
    await db.close();
  }
});

test('a recreated pair cannot accept any operation from its previous epoch', async () => {
  const { migrateDurable, DurableStore } = require('../relay/src/durableStore.mjs');
  const db = new PGlite();
  try {
    await migrate(db);
    await migrateDurable(db);
    const insert = () =>
      db.query(
        "INSERT INTO relay_pairs (pair_id,user_id,mac_device_id,phone_device_id,join_deadline,created_at) VALUES ('p_test0001','u','mac','phone',now(),now())",
      );
    await insert();
    const store = new DurableStore((fn: any) => db.transaction(fn));
    const old = await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' });
    await db.query("DELETE FROM relay_pairs WHERE pair_id='p_test0001'");
    await insert();
    const next = await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' });
    assert.notEqual(old.epoch, next.epoch);
    const a = {
      pairId: 'p_test0001',
      epoch: old.epoch,
      userId: 'u',
      dir: 'm2p',
      sender: 'mac',
      receiver: 'phone',
      now: 1000,
      ctr: 1,
      id: 'unused',
    };
    assert.equal((await store.waiting(a)).code, 'retired');
    assert.equal((await store.expire(a.pairId, a.epoch, 1000)).code, 'retired');
    assert.equal((await store.drops(a)).code, 'retired');
    assert.equal((await store.ackDrop(a)).code, 'retired');
    assert.equal((await store.openEpoch({ pairId: a.pairId, userId: 'u', sender: 'mac' })).epoch, next.epoch);
    assert.equal((await store.openEpoch(null)).code, 'forbidden');
    assert.equal((await store.openEpoch({ pairId: a.pairId })).code, 'forbidden');
    assert.equal((await store.waiting(null)).code, 'invalid');
    assert.equal((await store.waiting({ ...a, now: Number.MAX_SAFE_INTEGER })).code, 'invalid');
    const f = {
      pairId: 'p_test0001',
      epoch: old.epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 1,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    assert.equal((await store.enqueue(f)).code, 'retired');
    assert.equal((await store.enqueue({ ...f, epoch: next.epoch })).code, 'stored');
  } finally {
    await db.close();
  }
});

test('a frame at expiry is neither delivered nor acknowledged before the sweep records its notice', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const f = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.alloc(24),
      box: Buffer.from([1]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 5,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    const added = await store.enqueue(f);
    const recipient = { pairId: f.pairId, epoch, userId: 'u', receiver: 'phone', dir: f.dir, ctr: 1, id: added.id };
    assert.equal((await store.waiting({ ...recipient, now: 1099 })).frames.length, 1);
    assert.equal((await store.waiting({ ...recipient, now: 1100 })).code, 'expired');
    assert.equal((await store.ack({ ...recipient, now: 1100 })).code, 'expired');
    assert.equal((await store.enqueue({ ...f, now: 1100 })).code, 'expired');
    assert.equal((await store.expire(f.pairId, epoch, 1100)).count, 1);
    assert.equal((await store.drops({ pairId: f.pairId, epoch, userId: 'u', sender: 'mac', dir: f.dir })).drops.length, 1);
    assert.equal((await store.ack({ ...recipient, now: 1101 })).code, 'gone');
  } finally {
    await db.close();
  }
});
