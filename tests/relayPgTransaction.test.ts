// relay/src/pgTransaction.mjs: the durable store's transaction runner over a pg-style pool (one connection, COMMIT or ROLLBACK, always released) or an in-process database's own transaction().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transactionRunner } from '../relay/src/pgTransaction.mjs';

function pool(o: { failRollback?: boolean } = {}) {
  const log: string[] = [];
  const conn: any = {
    query: async (sql: string) => {
      log.push(sql);
      if (o.failRollback && sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    },
    release: () => log.push('release'),
  };
  return { log, db: { connect: async () => conn } };
}

test('a pool connection runs the work in BEGIN..COMMIT and is released', async () => {
  const { db, log } = pool();
  const result = await transactionRunner(db)(async (tx: any) => (await tx.query('SELECT 1'), 'done'));
  assert.equal(result, 'done');
  assert.deepEqual(log, ['BEGIN', 'SELECT 1', 'COMMIT', 'release']);
});

test('an error rolls back, is rethrown, and the connection is still released, even if the rollback itself fails', async () => {
  for (const failRollback of [false, true]) {
    const { db, log } = pool({ failRollback });
    await assert.rejects(
      transactionRunner(db)(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(log, ['BEGIN', 'ROLLBACK', 'release']);
  }
});

test('a database with its own transaction() uses it', async () => {
  const seen: unknown[] = [];
  const db = { transaction: async (work: any) => work(seen) };
  assert.equal(await transactionRunner(db as any)(async (tx: any) => tx === seen), true);
});
