// What keeps the mailbox from growing: the TTL sweep really deletes expired frames, the hot queries use their indexes, the frame table is vacuumed early, and the migrations can run again (and at the same time as a running relay) without harm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../relay/src/schema.mjs';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeHub, makeDb, P, frame, MAILBOX, settle } from './support/relayKit.ts';

const { db } = await makeDb();
await migrateDurable(db);

test('the sweep deletes a frame past its TTL from the table, tells the sender once, and a late repeat of it is not stored again', async () => {
  await db.exec('TRUNCATE relay_pairs CASCADE');
  const r = makeHub(db, { durable: true, mailbox: { ...MAILBOX, ttlMs: 60_000 } });
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  phone.socket.closedWith = null;
  phone.h.close(1006);
  await settle(r.hub);
  await mac.say(frame('m2p', 1));
  await mac.say(frame('m2p', 2));
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM remote_durable.frames')).rows[0].n), 2);
  r.clock.advance(61_000);
  await r.hub.sweep();
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM remote_durable.frames')).rows[0].n), 0, 'the rows are gone, not hidden');
  const drops = mac.socket.events('mailbox.dropped');
  assert.deepEqual(
    drops.map((d) => [d.count, d.firstCtr, d.lastCtr]),
    [[2, 1, 2]],
  );
  await r.hub.sweep();
  assert.equal(mac.socket.events('mailbox.dropped').length, 1, 'a second sweep has nothing to say');
  // a late retransmission of an expired frame is answered as consumed, not stored again
  await mac.say(frame('m2p', 2));
  assert.equal(mac.socket.last().via, 'consumed');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM remote_durable.frames')).rows[0].n), 0);
});

test("the hot queries use indexes: the next frames of a stream, the frame with a counter, the pair's usage, and what has expired", async () => {
  await db.exec('SET enable_seqscan = off');
  const plan = async (sql: string, params: unknown[]) =>
    (await db.query(`EXPLAIN ${sql}`, params)).rows.map((r: any) => r['QUERY PLAN']).join('\n');
  const deliverable = await plan(
    'SELECT id,ctr,nonce,box FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 AND ctr > $3 AND expires_at > $4 ORDER BY ctr LIMIT $5',
    ['p', 'm2p', 0, new Date(), 50],
  );
  assert.match(deliverable, /Index.*frames_pair_id_dir_ctr_key/);
  assert.doesNotMatch(deliverable, /Sort/, 'the index already gives the order');
  assert.match(
    await plan('SELECT id FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 AND ctr = $3', ['p', 'm2p', 1]),
    /Index.*frames_pair_id_dir_ctr_key/,
  );
  assert.match(await plan('SELECT count(*) FROM remote_durable.frames WHERE pair_id = $1', ['p']), /Index.*frames_pair_id_dir_ctr_key/);
  assert.match(
    await plan('SELECT DISTINCT pair_id FROM remote_durable.frames WHERE expires_at <= $1', [new Date()]),
    /Index.*frames_expiry/,
  );
  assert.match(await plan('DELETE FROM remote_durable.frames WHERE pair_id = $1 AND expires_at <= $2', ['p', new Date()]), /Index/);
  await db.exec('RESET enable_seqscan');
});

test('the frame table is vacuumed after 2% dead rows, not the default 20%', async () => {
  const { rows } = await db.query("SELECT reloptions FROM pg_class WHERE oid = 'remote_durable.frames'::regclass");
  assert.deepEqual(rows[0].reloptions.sort(), [
    'autovacuum_analyze_scale_factor=0.05',
    'autovacuum_vacuum_scale_factor=0.02',
    'autovacuum_vacuum_threshold=200',
  ]);
});

test('running the migrations again changes nothing and keeps the rows', async () => {
  const fresh = new PGlite();
  await migrate(fresh as any);
  await migrateDurable(fresh);
  await fresh.query(
    "INSERT INTO relay_pairs (pair_id, user_id, mac_device_id, phone_device_id, join_deadline, created_at) VALUES ('p_keepme001', 'u', 'm', 'p', now(), now())",
  );
  await fresh.query("INSERT INTO relay_revoked_devices (device_id, user_id, revoked_at) VALUES ('old', 'u', now())");
  for (let i = 0; i < 3; i++) {
    await migrate(fresh as any);
    await migrateDurable(fresh);
  }
  const count = async (table: string) => Number(((await fresh.query(`SELECT count(*) AS n FROM ${table}`)) as any).rows[0].n);
  assert.equal(await count('relay_pairs'), 1);
  assert.equal(await count('relay_revoked_devices'), 1);
  await fresh.close();
});
