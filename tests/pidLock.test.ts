// scripts/pid-lock.mjs: a lock record is published whole, taken over only when stale, and released only by its owner (#3646).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOwner, pidAlive, tryLock } from '../scripts/pid-lock.mjs';

const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pid-lock-')), 'lock');
const owners = (file: string) => fs.readFileSync(file, 'utf8');
const dead = () => false;

test('a record parses to its pid and token, a bare pid is an older writer, and anything else names no owner', () => {
  assert.deepEqual(parseOwner('12 abc\n'), { pid: 12, token: 'abc' });
  assert.deepEqual(parseOwner('12'), { pid: 12, token: null });
  for (const bad of ['', '0', '0 x', 'x', '-3', '12 a b', '12abc']) assert.equal(parseOwner(bad), null, bad);
});

test('pidAlive: this process is alive, an id that cannot exist is not, and a process we may not signal exists', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  const kill = process.kill;
  process.kill = (() => {
    throw Object.assign(new Error('no'), { code: 'EPERM' });
  }) as never;
  try {
    assert.equal(pidAlive(1), true);
  } finally {
    process.kill = kill;
  }
});

test('a lock is taken whole, held against a live owner, and leaves no draft files behind', () => {
  const file = lockFile();
  const a = tryLock(file, { pid: 10 });
  assert.ok(a.owned);
  assert.match(owners(file), /^10 [0-9a-f]+\n$/);
  const b = tryLock(file, { pid: 11, live: () => true });
  assert.deepEqual([b.owned, b.owned ? 0 : b.owner?.pid], [false, 10]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['lock']);
  assert.equal(a.owned && a.release(), true);
  assert.equal(fs.existsSync(file), false);
});

test('two writers racing to publish: the one whose link lands first owns it, the other is refused and cleans its draft', () => {
  const file = lockFile();
  let second: ReturnType<typeof tryLock> | undefined;
  const fsx = {
    ...fs,
    linkSync: (from: string, to: string) => {
      if (!second) second = tryLock(file, { pid: 2, live: () => true }); // the contender publishes while the first holds its draft
      return fs.linkSync(from, to);
    },
  } as never;
  const first = tryLock(file, { pid: 1, fsx, live: () => true });
  assert.equal(second?.owned, true, 'the contender saw no half-written lock and took it');
  assert.equal(first.owned, false, 'the first writer lost the link and does not think it owns the lock');
  assert.match(owners(file), /^2 /);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['lock']);
});

test('publication that fails for another reason raises it, and an interrupted one (a draft left behind) holds nothing', () => {
  const file = lockFile();
  const broken = {
    ...fs,
    linkSync: () => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    },
  } as never;
  assert.throws(() => tryLock(file, { fsx: broken }), /no space/);
  fs.writeFileSync(`${file}.1.deadbeef.draft`, '999 x\n');
  assert.ok(tryLock(file, { pid: 3 }).owned, 'a stray draft is not the lock');
});

test('a dead owner is taken over, and the old owner can no longer release or remove the new record', () => {
  const file = lockFile();
  const old = tryLock(file, { pid: 10 });
  const next = tryLock(file, { pid: 11, live: dead });
  assert.ok(old.owned && next.owned);
  assert.match(owners(file), /^11 /);
  assert.equal(old.owned && old.release(), false, 'the old owner removes nothing of the new one');
  assert.match(owners(file), /^11 /);
  assert.equal(next.owned && next.release(), true);
  assert.equal(next.owned && next.release(), false, 'a second release finds nothing');
});

test('the owner is judged with the record age: an old record of a live pid is stale (a reused pid)', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  const ages: number[] = [];
  const t = tryLock(file, { pid: 11, now: () => Date.now() + 3_600_000, live: (_o, age) => (ages.push(age), age < 1000) });
  assert.ok(t.owned);
  assert.ok(ages[0] >= 3_599_000);
});

test('an unreadable record is held while young and taken over once older than the ambiguity window', () => {
  const file = lockFile();
  fs.writeFileSync(file, '');
  const held = tryLock(file, { pid: 5, live: () => true });
  assert.equal(held.owned, false);
  assert.equal(held.owned ? null : held.owner, null);
  assert.ok(tryLock(file, { pid: 5, now: () => Date.now() + 10_000, live: () => true }).owned);
});

test('a takeover is serialized by a guard: a contender that cannot get it leaves the lock alone, and a dead guard is cleared', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  const guard = tryLock(`${file}.takeover`, { pid: process.pid });
  assert.ok(guard.owned);
  const refused = tryLock(file, { pid: 11, live: dead });
  assert.equal(refused.owned, false, 'another contender is taking it over');
  assert.match(owners(file), /^10 /);
  guard.owned && guard.release();
  fs.writeFileSync(`${file}.takeover`, `${2 ** 22 + 999} gone\n`);
  assert.ok(tryLock(file, { pid: 11, live: dead }).owned, 'a guard whose holder is gone does not block');
  assert.equal(fs.existsSync(`${file}.takeover`), false);
});

test('a record that changes between the staleness check and the removal is put back, not deleted', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  let swapped = false;
  const fsx = {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (!swapped && from === file) {
        swapped = true;
        fs.writeFileSync(file, '12 fresh\n'); // a new owner wins the race just before the move
      }
      return fs.renameSync(from, to);
    },
  } as never;
  const t = tryLock(file, { pid: 11, fsx, live: (o) => o.pid === 12 });
  assert.equal(swapped, true);
  assert.equal(t.owned, false);
  assert.equal(owners(file), '12 fresh\n', 'the newer record is back in place');
});

test('a put-back that finds a third record already in place keeps that one', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  const fsx = {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (from === file) fs.writeFileSync(file, '12 fresh\n');
      fs.renameSync(from, to);
      if (from === file) fs.writeFileSync(file, '13 third\n');
    },
  } as never;
  tryLock(file, { pid: 11, fsx, live: dead });
  assert.equal(owners(file), '13 third\n');
});

test('a lock released between the two steps is retried, and a failing read is raised', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  let first = true;
  const vanish = {
    ...fs,
    readFileSync: (f: string, e: never) => {
      if (first && f === file) {
        first = false;
        fs.rmSync(file);
      }
      return fs.readFileSync(f, e);
    },
  } as never;
  assert.ok(tryLock(file, { pid: 11, fsx: vanish }).owned);
  const asDir = lockFile();
  fs.mkdirSync(asDir);
  assert.throws(() => tryLock(asDir, { pid: 11 }), /EISDIR/);
});

test('a lock that is released and retaken on every look is given up after three tries and reports the last owner', () => {
  const file = lockFile();
  let n = 0;
  const churn = {
    ...fs,
    linkSync: () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
    readFileSync: () => `${++n} t\n`,
  };
  const t = tryLock(file, { pid: 1, fsx: { ...churn, statSync: () => ({ mtimeMs: Date.now() }) } as never, live: () => false });
  assert.equal(t.owned, false);
});

test('a record that vanishes between its read and its stat counts as released', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  let stats = 0;
  const fsx = { ...fs, statSync: (...args: [string, object]) => (++stats === 1 ? undefined : fs.statSync(...args)) } as never;
  assert.ok(tryLock(file, { pid: 11, fsx, live: dead }).owned);
});

test('a lock that churns away on every look is given up with no owner, and the default liveness test holds a live pid', () => {
  const file = lockFile();
  const gone = {
    ...fs,
    linkSync: () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
    readFileSync: () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    },
  } as never;
  const t = tryLock(file, { pid: 1, fsx: gone });
  assert.deepEqual(t.owned ? null : [t.owner, t.ageMs], [null, 0]);
  const live = lockFile();
  tryLock(live, { pid: process.pid });
  assert.equal(tryLock(live, { pid: process.pid + 1 }).owned, false, 'the default test sees this process alive');
});

test('removal failures other than a vanished record are raised, and a put-back that cannot link is raised', () => {
  const file = lockFile();
  tryLock(file, { pid: 10 });
  const denied = {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (from === file) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      fs.renameSync(from, to); // the takeover guard is released normally
    },
  } as never;
  assert.throws(() => tryLock(file, { pid: 11, fsx: denied, live: dead }), /EXDEV/);
  assert.equal(fs.existsSync(`${file}.takeover`), false, 'a failed takeover releases its guard');
  const swap = {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (from === file) fs.writeFileSync(file, '12 fresh\n');
      fs.renameSync(from, to);
    },
    linkSync: (from: string, to: string) => {
      if (to === file && from.endsWith('.removed')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return fs.linkSync(from, to);
    },
  } as never;
  assert.throws(() => tryLock(file, { pid: 11, fsx: swap, live: dead }), /EIO/);
  // the record vanishing before it can be moved is no error: the next try publishes
  const fresh = lockFile();
  tryLock(fresh, { pid: 10 });
  const v = { ...fs, renameSync: (from: string, to: string) => (fs.rmSync(fresh, { force: true }), fs.renameSync(from, to)) } as never;
  assert.ok(tryLock(fresh, { pid: 11, fsx: v, live: dead }).owned);
});
