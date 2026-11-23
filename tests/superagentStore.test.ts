// Superagent store (electron/superagent/store, lifecycle): schema, event claims, owed events, outbox leases, damaged database, flag flip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const {
  openStore: realOpenStore,
  createStore,
  acknowledgeDamage,
  StoreDamagedError,
  StoreNewerError,
} = require('../electron/superagent/store/index.cjs');
const { migrate, assertKnown, MIGRATIONS } = require('../electron/superagent/store/migrations.cjs');

/** The store opens files through the fs it is given: main passes node:fs. */
const openStore = (o: any) => realOpenStore({ fsOps: fs, ...o });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-superagent-'));
let ids = 0;
function mem(start = 1000) {
  const clock = { t: start };
  const now = () => clock.t;
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { clock, store: createStore({ db, now, newId: () => `alloc-${++ids}` }) };
}

test('migrate builds the schema once, rolls back a failing step and refuses a newer schema', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r: any) => r.name);
  assert.deepEqual(
    ['events', 'outbox', 'owed'].filter((n) => names.includes(n)),
    ['events', 'outbox', 'owed'],
  );

  const fresh = new DatabaseSync(':memory:');
  assert.throws(
    () =>
      migrate(fresh, [
        (d: any) => d.exec('CREATE TABLE a (x)'),
        () => {
          throw new Error('boom');
        },
      ]),
    /boom/,
  );
  assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, 1, 'the first step stays, the failed one rolled back');

  assert.throws(() => assertKnown(fresh, []), StoreNewerError);
  fresh.exec('PRAGMA user_version = 3');
  assert.throws(() => migrate(fresh, [() => {}]), StoreNewerError);
});

test('record stores an event once; a duplicate delivery changes nothing', () => {
  const { store } = mem();
  const a = store.events.record('github', 'n1', { text: 'hi' });
  const b = store.events.record('github', 'n1', { text: 'changed' });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(a.id, b.id);
  assert.deepEqual(store.events.get('github', 'n1').payload, { text: 'hi' });
  assert.equal(store.events.get('github', 'nope'), undefined);
  assert.equal(store.events.record('slack', 'n1', {}).inserted, true, 'the same id on another source is another event');
});

test('claim: one winner, TTL expiry (restart mid-claim), complete is final, release retries', () => {
  const { store, clock } = mem();
  const e = store.events;
  e.record('github', 'n1', {});
  assert.equal(e.claim('github', 'n1', 'A', 100), true);
  assert.equal(e.claim('github', 'n1', 'B', 100), false, 'a live claim holds');
  clock.t += 100; // the process died; the TTL ran out
  assert.equal(e.claim('github', 'n1', 'B', 100), true);
  assert.equal(e.complete('github', 'n1', 'A'), false, 'the old owner lost it');
  assert.equal(e.release('github', 'n1', 'A'), false);
  assert.equal(e.complete('github', 'n1', 'B'), true);
  assert.equal(e.claim('github', 'n1', 'C', 100), false, 'a done event is never claimed again');
  clock.t += 1000;
  assert.equal(e.claim('github', 'n1', 'C', 100), false);
  assert.equal(e.release('github', 'n1', 'B'), false, 'done keeps its claim');
  assert.equal(e.claim('github', 'unknown', 'A', 1), false);
});

test('handle: releases before the side effect, keeps done after it, reports duplicate, busy and lost', async () => {
  const { store, clock } = mem();
  const e = store.events;
  e.record('github', 'n1', { v: 1 });

  await assert.rejects(
    e.handle('github', 'n1', 'A', 100, async () => {
      throw new Error('early');
    }),
    /early/,
  );
  assert.equal(e.get('github', 'n1').claim_owner, null, 'released: the next delivery retries');

  let seen: any;
  assert.equal(
    await e.handle('github', 'n1', 'A', 100, async (ev: any, { commit }: any) => {
      seen = ev;
      commit();
    }),
    'done',
  );
  assert.deepEqual(seen.payload, { v: 1 });
  assert.equal(await e.handle('github', 'n1', 'B', 100, async () => assert.fail('never runs')), 'duplicate');

  e.record('github', 'n2', {});
  await assert.rejects(
    e.handle('github', 'n2', 'A', 100, async (_: any, { commit }: any) => {
      commit();
      throw new Error('late');
    }),
    /late/,
  );
  assert.ok(e.get('github', 'n2').done_at, 'failed after the side effect: done, never repeated');

  e.record('github', 'n3', {});
  e.claim('github', 'n3', 'A', 100);
  assert.equal(await e.handle('github', 'n3', 'B', 100, async () => assert.fail('never runs')), 'busy');

  assert.equal(await e.handle('github', 'missing', 'A', 100, async () => assert.fail('never runs')), 'busy');

  // a handler that outlives its TTL while another owner took over reports the lost claim
  e.record('github', 'n4', {});
  assert.equal(
    await e.handle('github', 'n4', 'A', 100, async () => {
      clock.t += 200;
      e.claim('github', 'n4', 'B', 100);
    }),
    'lost',
  );
});

test('two concurrent handlers: exactly one runs', async () => {
  const { store } = mem();
  store.events.record('github', 'n1', {});
  let runs = 0;
  const h = async (_: any, { commit }: any) => {
    commit();
    runs++;
    await Promise.resolve();
  };
  const out = await Promise.all([store.events.handle('github', 'n1', 'A', 100, h), store.events.handle('github', 'n1', 'B', 100, h)]);
  assert.equal(runs, 1);
  assert.deepEqual([...out].sort(), ['busy', 'done']);
});

test('owed events stay owed until confirmed', () => {
  const { store } = mem();
  const a = store.events.record('github', 'a', {}).id;
  const b = store.events.record('github', 'b', {}).id;
  assert.equal(store.owed.owe('t1', b), true);
  assert.equal(store.owed.owe('t1', a), true);
  assert.equal(store.owed.owe('t1', a), false, 'owing twice is one debt');
  assert.deepEqual(store.owed.owedTo('t1'), [a, b]);
  assert.deepEqual(store.owed.owedTo('t2'), []);
  assert.equal(store.owed.confirm('t1', [a, 999]), 1);
  assert.equal(store.owed.confirm('t1', [a]), 0, 'confirmed once');
  assert.deepEqual(store.owed.owedTo('t1'), [b]);
});

test('outbox: idempotent enqueue, lease, stale holder cannot complete, heartbeat, retry and dead', () => {
  const { store, clock } = mem();
  const o = store.outbox;
  const first = o.enqueue({ kind: 'post', payload: { n: 1 }, idempotencyKey: 'k1' });
  const again = o.enqueue({ kind: 'post', payload: { n: 2 }, idempotencyKey: 'k1' });
  assert.deepEqual([first.created, again.created, again.id], [true, false, first.id]);
  o.enqueue({ kind: 'post', payload: {}, idempotencyKey: 'later', runAt: clock.t + 10_000 });

  const a = o.lease({ owner: 'w1', ttlMs: 100 });
  assert.equal(a.payload.n, 1);
  assert.equal(a.attempts, 1);
  assert.equal(o.lease({ owner: 'w2', ttlMs: 100 }), null, 'leased and not yet due: nothing to give');

  assert.equal(o.heartbeat(a.id, a.allocation_id, 100), true);
  clock.t += 150; // the lease ran out
  const b = o.lease({ owner: 'w2', ttlMs: 100 });
  assert.equal(b.id, a.id);
  assert.notEqual(b.allocation_id, a.allocation_id);
  assert.equal(o.heartbeat(a.id, a.allocation_id, 100), false);
  assert.equal(o.complete(a.id, a.allocation_id), false, 'the stale holder changes nothing');
  assert.equal(o.fail(a.id, a.allocation_id, { error: 'x' }), false);
  assert.equal(o.get(a.id).state, 'pending');
  assert.equal(o.complete(b.id, b.allocation_id, { ok: 1 }), true);
  assert.equal(o.get(b.id).state, 'done');
  assert.equal(o.complete(b.id, b.allocation_id), false);
  assert.equal(o.get(9999), undefined);

  // retry, then dead after maxAttempts
  const r = o.enqueue({ kind: 'post', payload: {}, idempotencyKey: 'r' });
  let l = o.lease({ owner: 'w', ttlMs: 100 });
  assert.equal(l.id, r.id);
  assert.equal(o.fail(l.id, l.allocation_id, { error: new Error('e1'), retryAt: clock.t + 50, maxAttempts: 2 }), true);
  assert.equal(o.lease({ owner: 'w', ttlMs: 100 }), null, 'not due before retryAt');
  clock.t += 50;
  l = o.lease({ owner: 'w', ttlMs: 100 });
  assert.equal(l.attempts, 2);
  assert.equal(o.fail(l.id, l.allocation_id, { error: 'e2', maxAttempts: 2 }), true);
  assert.equal(o.get(r.id).state, 'dead');
  assert.equal(o.get(r.id).error, 'e2');
  assert.equal(o.lease({ owner: 'w', ttlMs: 100 }), null);
});

test('outbox: an entry whose worker keeps dying is dead after maxAttempts, not leased forever', () => {
  const { store, clock } = mem();
  const o = store.outbox;
  const { id } = o.enqueue({ kind: 'k', payload: {}, idempotencyKey: 'dying' });
  assert.ok(o.lease({ owner: 'w', ttlMs: 10, maxAttempts: 2 }));
  clock.t += 10;
  assert.ok(o.lease({ owner: 'w', ttlMs: 10, maxAttempts: 2 }));
  clock.t += 10;
  assert.equal(o.lease({ owner: 'w', ttlMs: 10, maxAttempts: 2 }), null);
  assert.equal(o.get(id).state, 'dead');
  assert.match(o.get(id).error, /lease expired too many times/);
});

test('atomic commits, rolls back on a throw and joins a nested call', () => {
  const { store } = mem();
  const out = store.atomic(() => {
    store.events.record('github', 'a', {});
    return store.atomic(() => 7);
  });
  assert.equal(out, 7);
  assert.throws(
    () =>
      store.atomic(() => {
        store.events.record('github', 'b', {});
        throw new Error('no');
      }),
    /no/,
  );
  assert.equal(store.events.get('github', 'b'), undefined);
  assert.ok(store.events.get('github', 'a'));
  store.atomic(() => store.events.record('github', 'c', {}));
  assert.ok(store.events.get('github', 'c'), 'the depth counter reset after the throw');
});

test('openStore: first run creates the file, a restart keeps the data, the default id source works', () => {
  const file = path.join(dir(), 'sa.db');
  let t = 5;
  const s1 = openStore({ file, now: () => t });
  s1.events.record('github', 'n1', { a: 1 });
  s1.outbox.enqueue({ kind: 'k', payload: {}, idempotencyKey: 'x' });
  const lease = s1.outbox.lease({ owner: 'w', ttlMs: 1 });
  assert.match(lease.allocation_id, /^[0-9a-f-]{36}$/);
  s1.close();
  const s2 = openStore({ file, now: () => t });
  assert.deepEqual(s2.events.get('github', 'n1').payload, { a: 1 });
  assert.equal(s2.events.record('github', 'n1', {}).inserted, false, 'no replay after a restart');
  s2.close();
});

test('damaged database is set aside, the store stops until acknowledged, and nothing reads as empty', () => {
  const d = dir();
  const file = path.join(d, 'sa.db');
  fs.writeFileSync(file, 'this is not a sqlite file, '.repeat(200));
  assert.throws(
    () => openStore({ file, now: () => 42 }),
    (e: any) => e instanceof StoreDamagedError && e.setAside === `${file}.damaged-42`,
  );
  assert.ok(fs.existsSync(`${file}.damaged-42`), 'kept, never deleted');
  assert.equal(fs.existsSync(file), false);
  // a restart must not create an empty database in its place
  assert.throws(() => openStore({ file, now: () => 43 }), /stopped: the database could not be read/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(acknowledgeDamage(file, fs), true);
  assert.equal(acknowledgeDamage(file, fs), false);
  const s = openStore({ file, now: () => 44 });
  assert.equal(s.events.get('github', 'n1'), undefined, 'a fresh database only after the explicit acknowledge');
  s.close();
});

test('a database that fails its integrity check is set aside with its -wal and -shm files', () => {
  const file = path.join(dir(), 'sa.db');
  const renamed: string[] = [];
  let written = '';
  const present = new Set([file, `${file}-wal`]);
  const fsOps = {
    existsSync: (f: string) => present.has(f),
    renameSync: (a: string, b: string) => {
      renamed.push(`${path.basename(a)}>${path.basename(b)}`);
    },
    writeFileSync: (f: string, text: string) => {
      present.add(f);
      written = text;
    },
    readFileSync: () => '',
  };
  const fakeDb = {
    exec() {},
    prepare: () => ({ get: () => ({ quick_check: 'row 1 missing' }) }),
    close() {
      throw new Error('already broken');
    },
  };
  assert.throws(() => openStore({ file, now: () => 9, openDb: () => fakeDb, fsOps }), /integrity check failed: row 1 missing/);
  assert.match(String(written), /closing it also failed \(already broken\)/);
  assert.deepEqual(renamed, ['sa.db>sa.db.damaged-9', 'sa.db-wal>sa.db.damaged-9-wal']);
});

test('a locked or unopenable database is not damage: it stays where it is and nothing is set aside', () => {
  const file = path.join(dir(), 'sa.db');
  const first = openStore({ file, now: () => 1 });
  first.events.record('github', 'n1', {});
  first.close();
  // the real errors node:sqlite throws: SQLITE_BUSY (5) and SQLITE_CANTOPEN (14)
  for (const errcode of [5, 14]) {
    const failing = () => ({
      exec() {
        throw Object.assign(new Error('sqlite said no'), { errcode });
      },
      close() {},
    });
    assert.throws(
      () => openStore({ file, now: () => 2, openDb: failing }),
      (e: any) => !(e instanceof StoreDamagedError) && e.errcode === errcode,
    );
  }
  assert.equal(fs.existsSync(`${file}.stopped`), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes('damaged')),
    [],
  );
  const again = openStore({ file, now: () => 4 });
  assert.ok(again.events.get('github', 'n1'), 'the data is still there');
  again.close();
});

test('a database from a newer app is refused and left untouched', () => {
  const file = path.join(dir(), 'sa.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  assert.throws(() => openStore({ file, now: () => 1 }), StoreNewerError);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(`${file}.stopped`), false, 'not damage: no stop marker');
});
