// Superagent store hardening (#4112 review): durable commit, claim heartbeat, damage handling order, schema checks, backoff, atomic, drain.
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
const { migrate, MIGRATIONS } = require('../electron/superagent/store/migrations.cjs');
const { ClaimLostError } = require('../electron/superagent/store/events.cjs');

/** The store opens files through the fs it is given: main passes node:fs. */
const openStore = (o: any) => realOpenStore({ fsOps: fs, ...o });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-superagent-h-'));
/** A heartbeat timer the test fires by hand. */
function manualTimer() {
  const beats: Array<() => void> = [];
  const stopped: number[] = [];
  const every = (fn: () => void) => {
    beats.push(fn);
    const n = beats.length;
    return () => stopped.push(n);
  };
  return { every, beats, stopped };
}
function mem(o: any = {}) {
  const clock = { t: 1000 };
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { clock, store: createStore({ db, now: () => clock.t, newId: () => `a${clock.t}`, ...o }) };
}

test('commit is durable: a crash after the side effect leaves the event needing reconcile, never run again', async () => {
  const file = path.join(dir(), 'sa.db');
  let t = 1000;
  const s1 = openStore({ file, now: () => t });
  s1.events.record('github', 'n1', {});
  let effects = 0;
  // the process "dies" inside the handler, after commit and the side effect, before complete()
  s1.events.claim('github', 'n1', 'dead-process', 100);
  assert.equal(s1.events.commit('github', 'n1', 'dead-process'), true);
  effects++;
  s1.close();

  t += 10_000; // restart long after the claim's TTL
  const s2 = openStore({ file, now: () => t });
  assert.equal(s2.events.claim('github', 'n1', 'new', 100), false, 'a committed event is never claimed again');
  assert.equal(
    await s2.events.handle('github', 'n1', 'new', 100, async () => {
      effects++;
    }),
    'reconcile',
  );
  assert.equal(effects, 1);
  assert.deepEqual(s2.events.needsReconcile(), [{ source: 'github', externalId: 'n1', committedAt: 1000 }]);
  assert.equal(s2.events.release('github', 'n1', 'dead-process'), false, 'a committed claim is never released');
  assert.equal(s2.events.resolve('github', 'n1'), true);
  assert.equal(s2.events.resolve('github', 'n1'), false);
  assert.deepEqual(s2.events.needsReconcile(), []);
  assert.equal(await s2.events.handle('github', 'n1', 'new', 100, async () => {}), 'duplicate');
  s2.close();
});

test('a committed event with a live owner is busy, not reconcile; commit by a stranger is refused', async () => {
  const { store } = mem();
  const e = store.events;
  e.record('github', 'n1', {});
  e.claim('github', 'n1', 'A', 100);
  assert.equal(e.commit('github', 'n1', 'B'), false);
  assert.equal(e.commit('github', 'n1', 'A'), true);
  assert.equal(e.commit('github', 'n1', 'A'), false, 'committed once');
  assert.equal(await e.handle('github', 'n1', 'B', 100, async () => assert.fail('never runs')), 'busy');
  assert.deepEqual(e.needsReconcile(), [], 'a live owner is not a crash');
});

test('commit() throws ClaimLostError and the side effect does not run when the claim was taken over', async () => {
  const { store, clock } = mem();
  const e = store.events;
  e.record('github', 'n1', {});
  let effect = false;
  await assert.rejects(
    e.handle('github', 'n1', 'A', 100, async (_: any, { commit }: any) => {
      clock.t += 500; // TTL ran out with no heartbeat
      assert.equal(e.claim('github', 'n1', 'B', 100), true);
      commit();
      effect = true;
    }),
    ClaimLostError,
  );
  assert.equal(effect, false);
  assert.equal(e.get('github', 'n1').claim_owner, 'B', "A's failure did not touch B's claim");
});

test('a handler that outlives its TTL keeps its claim through the heartbeat, so a second owner cannot run', async () => {
  const timer = manualTimer();
  const { store, clock } = mem({ every: timer.every });
  const e = store.events;
  e.record('github', 'n1', {});
  let secondRan = false;
  let release: () => void = () => {};
  const slow = e.handle('github', 'n1', 'A', 300, async (_: any, { commit }: any) => {
    commit();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  for (let i = 0; i < 4; i++) {
    clock.t += 200; // each step is below the TTL, but the total is far above it
    timer.beats[0]();
    assert.equal(
      await e.handle('github', 'n1', 'B', 300, async () => {
        secondRan = true;
      }),
      'busy',
    );
  }
  assert.equal(secondRan, false);
  release();
  assert.equal(await slow, 'done');
  assert.deepEqual(timer.stopped, [1], 'the heartbeat stops with the handler');
  assert.equal(e.extendClaim('github', 'n1', 'A', 100), false, 'done: nothing to extend');
});

test('the heartbeat of a closed store does nothing, and a handler finishing after close leaves its claim alone', async () => {
  const timer = manualTimer();
  const { store } = mem({ every: timer.every });
  store.events.record('github', 'n1', {});
  store.events.record('github', 'n2', {});
  let finish: () => void = () => {};
  const run = store.events.handle('github', 'n1', 'A', 300, async () => {
    await new Promise<void>((r) => {
      finish = r;
    });
  });
  const failing = store.events.handle('github', 'n2', 'A', 300, async () => {
    await new Promise<void>((r, j) => {
      setTimeout(() => j(new Error('late failure')), 0);
    });
  });
  const drained = store.drain({ timeoutMs: 5, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) });
  await drained; // the slow handler outlived the wait: left running
  store.close();
  timer.beats[0](); // would throw on a closed database if it ran
  finish();
  assert.equal(await run, 'closed');
  await assert.rejects(failing, /late failure/);
});

test('drain waits for a running handler, then close is safe', async () => {
  const { store } = mem();
  store.events.record('github', 'n1', {});
  let release: () => void = () => {};
  const run = store.events.handle('github', 'n1', 'A', 300, async () => {
    await new Promise<void>((r) => {
      release = r;
    });
  });
  let drained = false;
  const d = store.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await d;
  assert.equal(await run, 'done');
  assert.equal(store.isOpen, true);
  store.close();
  assert.equal(store.isOpen, false);
});

test('damage: the stop marker is written before the renames; a crash between leaves it stopped with the file in place', () => {
  const file = path.join(dir(), 'sa.db');
  const events: string[] = [];
  const present = new Set([file, `${file}-wal`]);
  const fsOps = {
    existsSync: (f: string) => present.has(f),
    writeFileSync: (f: string) => {
      events.push(`write:${path.basename(f)}`);
      present.add(f);
    },
    readFileSync: () => 'stopped',
    renameSync: (a: string) => {
      events.push(`rename:${path.basename(a)}`);
      throw new Error('crash');
    },
  };
  const bad = { exec() {}, prepare: () => ({ get: () => ({ quick_check: 'bad' }) }), close() {} };
  assert.throws(() => openStore({ file, now: () => 7, openDb: () => bad, fsOps }), StoreDamagedError);
  assert.equal(events[0], 'write:sa.db.stopped', 'marker first');
  assert.equal(events[1], 'rename:sa.db');
  // the "restart" after the crash: stopped, and the original file was never replaced by an empty one
  assert.throws(() => openStore({ file, now: () => 8, openDb: () => bad, fsOps }), /Superagent is stopped/);
  assert.equal(present.has(file), true);
});

test('damage: if one rename fails the earlier ones are put back and it stays stopped', () => {
  const file = path.join(dir(), 'sa.db');
  const files = new Map([
    [file, 'db'],
    [`${file}-wal`, 'wal'],
    [`${file}-shm`, 'shm'],
  ]);
  const written: Record<string, string> = {};
  const fsOps = {
    existsSync: (f: string) => files.has(f) || f in written,
    writeFileSync: (f: string, text: string) => {
      written[f] = text;
    },
    readFileSync: (f: string) => written[f],
    renameSync: (a: string, b: string) => {
      if (a.endsWith('-shm') && !a.includes('damaged')) throw new Error('disk says no');
      files.set(b, files.get(a) as string);
      files.delete(a);
    },
  };
  const bad = { exec() {}, prepare: () => ({ get: () => ({ quick_check: 'bad' }) }), close() {} };
  let err: any;
  try {
    openStore({ file, now: () => 7, openDb: () => bad, fsOps });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof StoreDamagedError);
  assert.match(err.message, /could not set the damaged database aside \(disk says no\)/);
  assert.deepEqual([...files.keys()].sort(), [file, `${file}-shm`, `${file}-wal`].sort(), 'everything is back in place');
  assert.match(written[`${file}.stopped`], /could not be set aside/);
});

test('corruption is recognised in its extended forms; other codes are not damage', () => {
  for (const [errcode, damaged] of [
    [11, true],
    [26, true],
    [779, true],
    [523, true],
    [5, false],
    [261, false],
    [14, false],
    [270, false],
  ] as const) {
    const file = path.join(dir(), 'sa.db');
    const failing = {
      exec() {
        throw Object.assign(new Error('x'), { errcode });
      },
      close() {},
    };
    assert.throws(
      () => openStore({ file, now: () => 1, openDb: () => failing }),
      (e: any) => e instanceof StoreDamagedError === damaged,
      `errcode ${errcode}`,
    );
  }
  // an error with no code at all is not damage either
  const odd = {
    exec() {
      throw new Error('plain');
    },
    close() {},
  };
  assert.throws(
    () => openStore({ file: path.join(dir(), 'x.db'), now: () => 1, openDb: () => odd }),
    (e: any) => !(e instanceof StoreDamagedError),
  );
});

test('a newer-schema file is refused before journal_mode is touched', () => {
  const file = path.join(dir(), 'sa.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  db.close();
  assert.throws(() => openStore({ file, now: () => 1 }), StoreNewerError);
  const after = new DatabaseSync(file);
  assert.equal(after.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', 'the file was left as it was');
  after.close();
  assert.equal(fs.existsSync(`${file}-wal`), false);
});

test('migrate re-reads the version inside the transaction: a process that migrated first is not migrated over', () => {
  const file = path.join(dir(), 'sa.db');
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  let ran = 0;
  const step = (d: any) => {
    ran++;
    d.exec('CREATE TABLE t (x)');
  };
  let raced = false;
  const racing = new Proxy(a, {
    get: (t: any, k) =>
      k === 'exec'
        ? (sql: string) => {
            if (!raced && sql === 'BEGIN IMMEDIATE') {
              raced = true;
              migrate(b, [step]);
            }
            return t.exec(sql);
          }
        : typeof t[k] === 'function'
          ? t[k].bind(t)
          : t[k],
  });
  migrate(racing, [step]);
  assert.equal(ran, 1, 'the second process saw version 1 and skipped');
  a.close();
  b.close();
});

test('outbox fail() backs off exponentially by default and caps it', () => {
  const { store, clock } = mem();
  const o = store.outbox;
  const { id } = o.enqueue({ kind: 'k', payload: {}, idempotencyKey: 'b' });
  const delays: number[] = [];
  for (let i = 0; i < 12; i++) {
    clock.t += 10 * 60_000;
    const l = o.lease({ owner: 'w', ttlMs: 10, maxAttempts: 100 });
    assert.equal(l.id, id);
    const before = clock.t;
    o.fail(l.id, l.allocation_id, { error: 'x', maxAttempts: 100 });
    delays.push(o.get(id).run_at - before);
  }
  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(delays.at(-1), 5 * 60_000, 'capped');
  assert.equal(o.fail(9999, 'nobody', { error: 'x' }), false, 'an unknown entry changes nothing');
});

test('atomic refuses async work, rolls it back, and a failed rollback does not hide the original error', () => {
  const { store } = mem();
  assert.throws(
    () =>
      store.atomic(async () => {
        store.events.record('github', 'x', {});
      }),
    /must be synchronous/,
  );
  assert.equal(store.events.get('github', 'x'), undefined, 'rolled back');
  store.atomic(() => store.events.record('github', 'ok', {}));
  assert.ok(store.events.get('github', 'ok'));

  const db: any = {
    exec: (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback broke');
    },
  };
  const s = createStore({
    db: Object.assign(Object.create(null), db, { prepare: () => ({ run() {}, get() {}, all: () => [] }) }),
    now: () => 1,
  });
  let err: any;
  try {
    s.atomic(() => {
      throw new Error('original');
    });
  } catch (e) {
    err = e;
  }
  assert.equal(err.message, 'original');
  assert.equal(err.rollbackError.message, 'rollback broke');
});

test('acknowledge after damage starts a fresh database only then', () => {
  const file = path.join(dir(), 'sa.db');
  fs.writeFileSync(file, 'garbage'.repeat(300));
  assert.throws(() => openStore({ file, now: () => 5 }), StoreDamagedError);
  assert.throws(() => openStore({ file, now: () => 6 }), /stopped/);
  assert.equal(acknowledgeDamage(file, fs), true);
  openStore({ file, now: () => 7 }).close();
});
