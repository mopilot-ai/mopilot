// Durable store authorization and immutable input contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pairedDurableStore } from './helpers/relayDurableFixture';
const require = createRequire(import.meta.url);

test('a committed device revocation refuses new work even before pair deletion completes', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    await db.query("INSERT INTO relay_revoked_devices (device_id,user_id,revoked_at) VALUES ('mac','u',now())");
    assert.equal(
      (
        await store.enqueue({
          pairId: 'p_test0001',
          epoch,
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
        })
      ).code,
      'forbidden',
    );
  } finally {
    await db.close();
  }
});

test('either revoked peer blocks every authenticated operation in both directions', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const base = { pairId: 'p_test0001', userId: 'u', sender: 'mac' };
    const epoch = (await store.openEpoch(base)).epoch;
    for (const revoked of ['mac', 'phone']) {
      await db.query('INSERT INTO relay_revoked_devices (device_id,user_id,revoked_at) VALUES ($1,$2,now())', [revoked, 'u']);
      assert.equal((await store.openEpoch(base)).code, 'forbidden');
      for (const [dir, sender, receiver] of [
        ['m2p', 'mac', 'phone'],
        ['p2m', 'phone', 'mac'],
      ]) {
        const args = { ...base, epoch, dir, sender, receiver, ctr: 1, id: 'id', now: 1000 };
        assert.equal(
          (await store.enqueue({ ...args, nonce: Buffer.alloc(24), box: Buffer.from([1]), maxFrames: 1, maxBytes: 100, ttlMs: 100 })).code,
          'forbidden',
        );
        assert.equal((await store.waiting(args)).code, 'forbidden');
        assert.equal((await store.ack(args)).code, 'forbidden');
        assert.equal((await store.drops(args)).code, 'forbidden');
        assert.equal((await store.ackDrop(args)).code, 'forbidden');
      }
      await db.query('DELETE FROM relay_revoked_devices WHERE device_id = $1', [revoked]);
    }
  } finally {
    await db.close();
  }
});

test('enqueue snapshots caller data before a queued transaction starts', async () => {
  const { DurableStore } = require('../relay/src/durableStore.mjs');
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = new DurableStore(async (fn: any) => {
      await gate;
      return db.transaction(fn);
    });
    const f = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.from([1]),
      box: Buffer.from([2]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 1,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    const result = delayed.enqueue(f);
    f.ctr = 2;
    f.nonce[0] = 3;
    f.box[0] = 4;
    f.sender = 'phone';
    release();
    assert.equal((await result).code, 'stored');
    const row = (await store.waiting({ pairId: f.pairId, epoch, dir: 'm2p', receiver: 'phone', userId: 'u', now: 1000 })).frames[0];
    assert.equal(Number(row.ctr), 1);
    assert.deepEqual(Buffer.from(row.nonce), Buffer.from([1]));
    assert.deepEqual(Buffer.from(row.box), Buffer.from([2]));
  } finally {
    await db.close();
  }
});

test('transaction failure rolls back the frame and a retry can store it', async () => {
  const { DurableStore } = require('../relay/src/durableStore.mjs');
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    const failing = new DurableStore((fn: any) =>
      db.transaction((tx: any) =>
        fn({
          query: (sql: string, params: unknown[]) => {
            if (sql.includes('INSERT INTO remote_durable.streams')) throw new Error('write failed');
            return tx.query(sql, params);
          },
        }),
      ),
    );
    const frame = {
      pairId: 'p_test0001',
      epoch,
      dir: 'm2p',
      ctr: 1,
      nonce: Buffer.from([1]),
      box: Buffer.from([2]),
      sender: 'mac',
      userId: 'u',
      maxFrames: 1,
      maxBytes: 100,
      now: 1000,
      ttlMs: 100,
    };
    await assert.rejects(failing.enqueue(frame), /write failed/);
    assert.equal((await store.waiting({ ...frame, receiver: 'phone' })).frames.length, 0);
    assert.equal((await store.enqueue(frame)).code, 'stored');
  } finally {
    await db.close();
  }
});

test('a pair with no epoch row is retired for a caller that names none, and reads take no pair lock', async () => {
  const db = new PGlite();
  try {
    const store = await pairedDurableStore(db);
    const read = { pairId: 'p_test0001', userId: 'u', receiver: 'phone', dir: 'm2p', afterCtr: 0, limit: 5, now: 1000 };
    assert.equal((await store.deliverable({ ...read, epoch: null })).code, 'retired');
    assert.equal((await store.deliverable({ ...read, epoch: undefined })).code, 'retired');
    const statements: string[] = [];
    const watching = new (require('../relay/src/durableStore.mjs').DurableStore)((fn: any) =>
      db.transaction((tx: any) => fn({ query: (sql: string, p: unknown[]) => (statements.push(sql), tx.query(sql, p)) })),
    );
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    await watching.deliverable({ ...read, epoch });
    await watching.waiting({ pairId: 'p_test0001', userId: 'u', receiver: 'phone', dir: 'm2p', epoch, now: 1000 });
    await watching.drops({ pairId: 'p_test0001', userId: 'u', sender: 'mac', dir: 'm2p', epoch });
    assert.equal(statements.filter((s) => /FOR UPDATE/.test(s)).length, 0, 'a read does not lock the pair row');
    await watching.ackByCtr({ pairId: 'p_test0001', userId: 'u', receiver: 'phone', dir: 'm2p', epoch, ctr: 1, now: 1000 });
    assert.equal(statements.filter((s) => /FOR UPDATE/.test(s)).length, 1, 'a write does');
  } finally {
    await db.close();
  }
});
