// What one frame costs the database: a frame sent, delivered and acknowledged takes a fixed, small number of statements. The relay's throughput on a small VM is its round trips per frame (the load harness measured 27 before this budget), so a change that adds one fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeHub, P, frame } from './support/relayKit.ts';

test('a frame cycle (send, delivery, receipt) costs 7 statements in 3 transactions once the pair is known', async () => {
  const { db } = await makeDb();
  await migrateDurable(db);
  const seen: string[] = [];
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => (seen.push(`db: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`), query(sql, ...rest));
  const transaction = db.transaction.bind(db);
  let transactions = 0;
  db.transaction = (work: any) => {
    transactions++;
    return transaction((tx: any) =>
      work({
        query: (sql: string, ...rest: unknown[]) => (seen.push(`tx: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`), tx.query(sql, ...rest)),
      }),
    );
  };
  const r = makeHub(db, { durable: true });
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  // the first frame warms the pair's epoch and the caches
  await mac.say(frame('m2p', 1));
  await phone.say({ t: 'ack', pair: P, dir: 'm2p', ctr: 1 });
  seen.length = 0;
  transactions = 0;
  const cycles = 10;
  for (let ctr = 2; ctr < 2 + cycles; ctr++) {
    await mac.say(frame('m2p', ctr));
    await phone.say({ t: 'ack', pair: P, dir: 'm2p', ctr });
  }
  assert.equal(phone.socket.of('frame').length, cycles + 1, 'every frame reached the phone');
  assert.deepEqual(
    { statements: seen.length / cycles, transactions: transactions / cycles },
    { statements: 7, transactions: 3 },
    `statements per frame:\n${seen.slice(0, 7).join('\n')}`,
  );
  assert.equal(seen.filter((s) => s.startsWith('db:')).length, 0, 'nothing outside a transaction: the pair rows come from the cache');
});
