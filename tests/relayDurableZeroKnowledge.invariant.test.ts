// The optional durable schema stores only sealed frame bytes and bounded routing metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../relay/src/schema.mjs';
const require = createRequire(import.meta.url);

test('the durable schema retains no plaintext and exposes only expected columns', async () => {
  const { migrateDurable, DurableStore } = require('../relay/src/durableStore.mjs');
  const db = new PGlite();
  try {
    await migrate(db);
    await migrateDurable(db);
    await db.query(
      "INSERT INTO relay_pairs (pair_id,user_id,mac_device_id,phone_device_id,join_deadline,created_at) VALUES ('p_test0001','u','mac','phone',now(),now())",
    );
    const secret = 'Private chat content which must not reach the relay';
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), randomBytes(12));
    const box = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
    const store = new DurableStore((fn: any) => db.transaction(fn));
    const epoch = (await store.openEpoch({ pairId: 'p_test0001', userId: 'u', sender: 'mac' })).epoch;
    assert.equal(
      (
        await store.enqueue({
          pairId: 'p_test0001',
          epoch,
          dir: 'm2p',
          ctr: 1,
          nonce: randomBytes(24),
          box,
          sender: 'mac',
          userId: 'u',
          maxFrames: 2,
          maxBytes: 1000,
          now: 1000,
          ttlMs: 5000,
        })
      ).code,
      'stored',
    );
    const columns = await db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='remote_durable' ORDER BY table_name,ordinal_position",
    );
    assert.deepEqual(
      columns.rows.map((r: any) => `${r.table_name}.${r.column_name}`),
      [
        'drops.id',
        'drops.pair_id',
        'drops.dir',
        'drops.first_ctr',
        'drops.last_ctr',
        'drops.dropped',
        'drops.at',
        'epochs.pair_id',
        'epochs.epoch',
        'frames.id',
        'frames.pair_id',
        'frames.dir',
        'frames.ctr',
        'frames.nonce',
        'frames.box',
        'frames.expires_at',
        'gaps.pair_id',
        'gaps.dir',
        'gaps.lo',
        'gaps.hi',
        'streams.pair_id',
        'streams.dir',
        'streams.highwater',
      ],
    );
    const dump = Buffer.from(await (await db.dumpDataDir('none')).arrayBuffer());
    assert.equal(dump.includes(Buffer.from(secret)), false);
  } finally {
    await db.close();
  }
});
