// A whole run of the relay load harness (scripts/relay-load/run.mjs): on PGlite with restarts, socket kills and a burst; against a Postgres-like database with the relay as a child process; and the ways a run ends early.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { formatReport } from '../scripts/relay-load/stats.mjs';
import { DEFAULTS, runLoad } from '../scripts/relay-load/run.mjs';
import { verdict } from '../scripts/relay-load/cli.mjs';
import { migrate } from '../relay/src/schema.mjs';
import { migrateDurable } from '../relay/src/durableStore.mjs';

test('a load run on PGlite restarts the relay, cuts sockets, bursts and reports nothing lost; the Postgres path truncates first', async () => {
  const logs: string[] = [];
  const report: any = await runLoad(
    {
      pairs: 3,
      seconds: 2,
      macRate: 8,
      phoneRate: 2,
      restarts: 1,
      restartDownMs: 50,
      killRate: 1,
      burst: { at: 0.2, pairs: 10, frames: 3, size: 200 },
      drainSeconds: 30,
    },
    { log: (l) => logs.push(l) },
  );
  assert.equal(report.mode, 'in-process + PGlite');
  assert.equal(report.ledger.lost, 0);
  assert.equal(report.drained, true);
  assert.equal(report.mailboxLeft, 0);
  assert.equal(report.chaos.relayRestarts, 1);
  assert.ok(report.chaos.socketsKilled >= 1);
  assert.equal(report.relayCloseCodes, undefined);
  assert.ok(logs.includes('draining'));
  assert.equal(verdict(report), 0);
  assert.match(formatReport(report), /LOST 0/);

  // the Postgres path: the relay is a child process (here on its own PGlite, so no restart), the harness pool a stand-in
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const bin = path.join(dir, 'relay.mjs');
  const main = new URL('../relay/src/main.mjs', import.meta.url).href;
  const pg = new URL('../node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
  await writeFile(bin, `import { run } from '${main}'; import { PGlite } from '${pg}'; await run(process.env, { pool: new PGlite() });`);
  const urls: string[] = [];
  const options = { pairs: 2, seconds: 1, database: 'postgres://127.0.0.1/x', restarts: 0, killRate: 0, burst: null, drainSeconds: 30 };
  // a database the relay has not migrated has no mailbox table to count: the run fails, and still stops the child
  await assert.rejects(runLoad(options, { makePool: (async () => new PGlite()) as any, bin }), /remote_durable.frames/);
  const migrated = new PGlite();
  await migrate(migrated as any);
  await migrateDurable(migrated);
  const quiet: any = await runLoad(options, { makePool: (async (url: string) => (urls.push(url), migrated)) as any, bin });
  assert.deepEqual(urls, ['postgres://127.0.0.1/x']);
  assert.equal(quiet.mode, 'child process + Postgres');
  assert.equal(typeof quiet.relayCloseCodes, 'object');
  assert.equal(quiet.ledger.lost, 0);
  assert.equal(DEFAULTS.pairs, 500);
});

/** A relay script for a child process that serves on its own PGlite; the second time it is started it exits (a port clash, a crash on boot). */
async function scripts() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-load-'));
  const main = new URL('../relay/src/main.mjs', import.meta.url).href;
  const pg = new URL('../node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
  const once = path.join(dir, 'once.mjs');
  const marker = path.join(dir, 'started');
  await writeFile(
    once,
    `import { existsSync, writeFileSync } from 'node:fs'; import { run } from '${main}'; import { PGlite } from '${pg}';
if (existsSync('${marker}')) { console.error('port in use'); process.exit(3); }
writeFileSync('${marker}', '1'); await run(process.env, { pool: new PGlite() });`,
  );
  return { once };
}

test('a restart that fails ends the run with its error and still stops the relay; a database off this machine is not truncated', async () => {
  const { once } = await scripts();
  const harnessPool = new PGlite();
  await assert.rejects(
    runLoad(
      {
        pairs: 1,
        seconds: 5,
        database: 'postgres://u@127.0.0.1/db',
        restarts: 1,
        restartDownMs: 10,
        killRate: 0,
        burst: null,
        drainSeconds: 5,
      },
      { makePool: (async () => harnessPool) as any, bin: once },
    ),
    /relay exited with 3: port in use/,
  );
  await assert.rejects(
    runLoad({ pairs: 1, seconds: 1, database: 'postgres://db.example.com/relay' }, { makePool: (async () => new PGlite()) as any }),
    /refusing to truncate the relay's tables on db.example.com/,
  );
});

test('a Postgres run empties the relay tables first, only those, and says so when the mailbox cannot be read at the end', async () => {
  const { once } = await scripts();
  const pool = new PGlite();
  await migrate(pool as any);
  await migrateDurable(pool);
  await pool.query(
    "INSERT INTO relay_pairs (pair_id, user_id, mac_device_id, join_deadline, created_at) VALUES ('p_stale00001', 'u', 'm', now(), now())",
  );
  await pool.query('CREATE TABLE other_app (x int)');
  await pool.query('INSERT INTO other_app VALUES (1)');
  const unreadable = {
    query: (sql: string, params?: unknown[]) =>
      sql.includes('pair_id, dir, ctr') ? Promise.reject(new Error('gone')) : pool.query(sql, params as any),
    close: () => pool.close(),
  };
  const report: any = await runLoad(
    { pairs: 1, seconds: 1, database: 'postgres://u@localhost/db', restarts: 0, killRate: 0, burst: null, drainSeconds: 20 },
    { makePool: (async () => unreadable) as any, bin: once },
  );
  assert.equal(report.mailboxKnown, false);
  assert.match(formatReport(report), /WARNING/);
  assert.equal(verdict(report), 1);
});
