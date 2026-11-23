// The key of MoMo's audit log and its helpers (#2139, electron/momo/auditKey.cjs, canonical.cjs, electron/gateway/durableWrite.cjs, fileLock.cjs) with a fake safeStorage: the key made once, sealed and synced, never made again over a log, refused when it can't be read or encryption is off; the entries' HMAC and the argument digest; canonical JSON; the folder lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { AuditError, unavailableError, loadAuditKey, macOf, macMatches, argsDigest } = require('../electron/momo/auditKey.cjs');
const { canonical } = require('../electron/momo/canonical.cjs');
const { writeDurable } = require('../electron/gateway/durableWrite.cjs');
const { acquireLock, ownProcess, LockError, pidAlive, EMPTY_GRACE, START_SLACK } = require('../electron/gateway/fileLock.cjs');
const { processStart } = require('../electron/platform/processIdentity.cjs');

function keyRig(o: { safe?: any; fs?: any; hasLog?: boolean } = {}) {
  const dir = path.join(scratch(), 'audit');
  const safe = o.safe ?? fakeSafe();
  const load = () =>
    loadAuditKey({
      file: path.join(dir, 'audit.key'),
      safe,
      fs: o.fs ?? fsp,
      hasLog: async () => o.hasLog ?? false,
      ensureDir: () => fsp.mkdir(dir, { recursive: true, mode: 0o700 }),
    });
  return { dir, safe, load, file: path.join(dir, 'audit.key') };
}

test('the key is made once, sealed, written whole (temp, sync, rename, folder sync) to a 0600 file and read back the same', async () => {
  const events: string[] = [];
  const watched = {
    ...fsp,
    open: async (f: string, ...a: any[]) => {
      const fh: any = await (fsp.open as any)(f, ...a);
      const what = f.endsWith('.tmp') ? 'tmp' : 'dir';
      return {
        write: (s: string) => (events.push(`write ${what}`), fh.write(s)),
        sync: () => (events.push(`sync ${what}`), fh.sync()),
        close: () => fh.close(),
      };
    },
    rename: (...a: any[]) => (events.push('rename'), (fsp.rename as any)(...a)),
  };
  const r = keyRig({ fs: watched });
  const key = await r.load();
  assert.equal(key.length, 32);
  assert.deepEqual(events, ['write tmp', 'sync tmp', 'rename', 'sync dir']);
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(r.dir), ['audit.key'], 'no temporary file left');
  assert.doesNotMatch(fs.readFileSync(r.file, 'utf8'), new RegExp(key.toString('hex')), 'never in plain text');
  assert.deepEqual(await r.load(), key);
});

test('a key file that cannot be opened is made again while there is no log; with a log, a missing or unreadable key refuses', async () => {
  await assert.rejects(
    keyRig({ hasLog: true }).load(),
    (e: any) => e instanceof AuditError && e.code === 'key' && /missing/.test(e.message),
  );
  const r = keyRig();
  fs.mkdirSync(r.dir, { recursive: true });
  // a crash between creating the file and writing it, a garbled key, a sealed text that isn't a key
  for (const content of ['', 'garbage', r.safe.encryptString('not hex').toString('base64')]) {
    fs.writeFileSync(r.file, content);
    const key = await r.load();
    assert.equal(key.length, 32, JSON.stringify(content));
    assert.deepEqual(await r.load(), key, 'and kept from then on');
  }
  const withLog = keyRig({ hasLog: true });
  fs.mkdirSync(withLog.dir, { recursive: true });
  fs.writeFileSync(withLog.file, '');
  await assert.rejects(withLog.load(), (e: any) => e.code === 'key' && /can't be read/.test(e.message));
  assert.equal(fs.readFileSync(withLog.file, 'utf8'), '', 'never replaced under a log');
  const locked = fakeSafe();
  locked.failEncrypt = true;
  const l = keyRig({ safe: locked });
  await assert.rejects(l.load(), { code: 'unavailable' });
  assert.equal(fs.existsSync(l.file), false);
  const denied = { ...fsp, readFile: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) };
  await assert.rejects(keyRig({ fs: denied }).load(), { code: 'EACCES' }, 'another read error is the error, not a new key');
  assert.equal(unavailableError().code, 'unavailable');
  // a failed rename leaves the old file and no temporary one
  const dir = scratch();
  const f = path.join(dir, 'x');
  fs.writeFileSync(f, 'old');
  await assert.rejects(writeDurable({ ...fsp, rename: async () => Promise.reject(new Error('EXDEV')) } as any, f, 'new'), /EXDEV/);
  assert.deepEqual([fs.readFileSync(f, 'utf8'), fs.readdirSync(dir)], ['old', ['x']]);
  await writeDurable(fsp, f, 'new');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
});

test('an entry HMAC checks out only unchanged, with its key and a well-formed mac', () => {
  const key = crypto.randomBytes(32);
  const entry = { v: 1, seq: 1, kind: 'intent', prev: '0'.repeat(64) };
  const signed = { ...entry, mac: macOf(key, entry) };
  assert.equal(macOf(key, signed), signed.mac, 'its own mac is left out');
  assert.equal(macMatches(key, signed), true);
  assert.equal(macMatches(key, { ...signed, seq: 2 }), false);
  assert.equal(macMatches(crypto.randomBytes(32), signed), false);
  assert.equal(macMatches(key, { ...signed, mac: 'nope' }), false);
  assert.equal(macMatches(key, { ...signed, v: Number.POSITIVE_INFINITY }), false, 'a value JSON reads as Infinity');
  // the digest: same arguments however written, other arguments or another key differ
  assert.equal(argsDigest(key, { a: 1, b: 2 }), argsDigest(key, { b: 2, a: 1 }));
  assert.notEqual(argsDigest(key, { a: 1 }), argsDigest(key, { a: 2 }));
  assert.notEqual(argsDigest(key, { a: 1 }), argsDigest(crypto.randomBytes(32), { a: 1 }));
  assert.equal(argsDigest(key, undefined), argsDigest(key, null));
});

test('canonical JSON: sorted keys at every level, NFC, undefined left out; values JSON cannot hold exactly are refused', () => {
  assert.equal(
    canonical({ b: 1, a: { d: [1, undefined, 'é'.normalize('NFD')], c: null }, u: undefined }),
    '{"a":{"c":null,"d":[1,null,"é"]},"b":1}',
  );
  const bare = Object.create(null);
  bare.z = true;
  bare.__proto__ = 'own';
  assert.equal(canonical(bare), '{"__proto__":"own","z":true}');
  assert.equal(canonical({ y: 1, x: 2 }), canonical({ x: 2, y: 1 }));
  let deep: any = 1;
  for (let i = 0; i < 70; i++) deep = [deep];
  for (const bad of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(0),
    () => 1,
    10n,
    Symbol('s'),
    deep,
    { ['é'.normalize('NFD')]: 1, ['é'.normalize('NFC')]: 2 },
  ])
    assert.throws(() => canonical(bad), TypeError, String(typeof bad));
});

test('the folder lock: one owner at a time, by pid and start time; a crashed owner or a reused pid is taken over; a release frees it', async () => {
  const dir = scratch();
  const file = path.join(dir, 'audit.lock');
  const runs = (started: number) => ({ isAlive: () => true, startOf: async () => started });
  const a = await acquireLock({ fs: fsp, file, pid: 111, started: 5_000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: 111, started: 5000 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(
    acquireLock({ fs: fsp, file, pid: 222, started: 9, ...runs(5_000) }),
    (e: any) => e instanceof LockError && e.code === 'locked' && /111/.test(e.message),
  );
  // a recorded start is an estimate and the clock may move: within the slack it is the same process
  await assert.rejects(acquireLock({ fs: fsp, file, pid: 222, started: 9, ...runs(5_000 + START_SLACK) }), { code: 'locked' });
  await assert.rejects(
    acquireLock({ fs: fsp, file, pid: 222, started: 9, isAlive: () => true, startOf: async () => null }),
    { code: 'locked' },
    'start unknown: still the owner',
  );
  // after a reboot the number belongs to another process, started at another time
  const b = await acquireLock({ fs: fsp, file, pid: 222, started: 9, ...runs(5_000 + START_SLACK + 1) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  await a.release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222, 'the old owner does not remove a lock it lost');
  await b.release();
  assert.equal(fs.existsSync(file), false);
  await b.release();
  // a crashed owner (its pid no longer runs)
  fs.writeFileSync(file, JSON.stringify({ pid: 333, started: 1 }));
  const c = await acquireLock({ fs: fsp, file, pid: 444, isAlive: () => false });
  await c.release();
  assert.deepEqual(fs.readdirSync(dir), [], 'the stale lock was moved aside and removed');
});

test('an empty lock is live while it is new; a takeover never removes a lock taken meanwhile', async () => {
  const dir = scratch();
  const file = path.join(dir, 'audit.lock');
  fs.writeFileSync(file, '');
  await assert.rejects(
    acquireLock({ fs: fsp, file, pid: 1, now: () => Date.now() }),
    (e: any) => e.code === 'locked' && /starting/.test(e.message),
  );
  const old = await acquireLock({ fs: fsp, file, pid: 1, now: () => Date.now() + EMPTY_GRACE + 1 });
  await old.release();
  // a lock that isn't ours to parse (an older format) is stale
  fs.writeFileSync(file, '111');
  await (await acquireLock({ fs: fsp, file, pid: 2 })).release();
  // another taker moved the stale lock and took it between our read and our rename: what we moved is theirs, so it goes back
  fs.writeFileSync(file, JSON.stringify({ pid: 5, started: 1 }));
  const racing = {
    ...fsp,
    rename: async (from: string, to: string) => {
      if (to.includes('.stale-')) fs.writeFileSync(from, JSON.stringify({ pid: 6, started: 2 }));
      return fsp.rename(from, to);
    },
  };
  await assert.rejects(
    acquireLock({ fs: racing as any, file, pid: 7, isAlive: () => false }),
    (e: any) => e.code === 'locked' && /taking over/.test(e.message),
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 6, 'their lock is back where it was');
  // the stale lock vanished before we moved it: we try to take it again, once
  const vanish = { ...fsp, rename: async () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) };
  await assert.rejects(acquireLock({ fs: vanish as any, file, pid: 8, isAlive: () => false }), { code: 'locked' });
  await assert.rejects(
    acquireLock({
      fs: { ...fsp, rename: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) } as any,
      file,
      pid: 9,
      isAlive: () => false,
    }),
    { code: 'EACCES' },
  );
  // a lock file whose age can't be read counts as old
  fs.writeFileSync(file, '');
  await (await acquireLock({ fs: { ...fsp, stat: async () => Promise.reject(new Error('EIO')) } as any, file, pid: 10 })).release();
  await assert.rejects(
    acquireLock({ fs: { ...fsp, open: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) } as any, file }),
    { code: 'EACCES' },
  );
  await assert.rejects(
    acquireLock({
      fs: { ...fsp, readFile: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) } as any,
      file: path.join(dir, 'held'),
      pid: 1,
    }).then((l) => l.release()),
    { code: 'EIO' },
    'a lock file that cannot be read back on release is the error',
  );
});

test('a lock file an older build wrote is read as it always was, and the file written now is one that build reads', async () => {
  const dir = scratch();
  const file = path.join(dir, 'older.lock');
  // what builds that asked ps wrote: the owner's pid and its start as milliseconds, with no birth
  const older = (pid: number, started: number) => fsp.writeFile(file, `{"pid":${pid},"started":${Math.round(started)}}`);
  const started = Date.now() - process.uptime() * 1000;

  // its live owner keeps it, by the real core's reading of the owner's start
  await older(process.pid, started);
  await assert.rejects(acquireLock({ fs: fsp, file, pid: 222, started: 9 }), { code: 'locked' });
  // a core that can't say keeps it too: not knowing never reads as gone
  await assert.rejects(acquireLock({ fs: fsp, file, pid: 222, started: 9, startOf: async () => null }), { code: 'locked' });

  // the pid is alive but started at another time: it isn't stolen from anyone, and isn't held forever
  await older(process.pid, started - 3_600_000);
  await (await acquireLock({ fs: fsp, file, pid: 222, started: 9 })).release();
  // nor when another user's process has the number now, as a root daemon can after a reboot: the core dates it (init here)
  await older(1, 5000);
  const taken = await acquireLock({ fs: fsp, file, pid: 222, started: 9 });
  // the same two fields in the same order: a build still comparing start times honours this lock
  assert.equal(await fsp.readFile(file, 'utf8'), '{"pid":222,"started":9}');
  await taken.release();
});

test('a clock stepped since launch leaves a live owner its lock: it records the start the kernel has, as a second instance reads it', async (t) => {
  const file = path.join(scratch(), 'stepped.lock');
  const real = Date.now;
  t.mock.method(Date, 'now', () => real() + 2 * START_SLACK);
  const owner = await acquireLock({ fs: fsp, file });
  t.mock.restoreAll();
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).started, await processStart(process.pid));
  await assert.rejects(acquireLock({ fs: fsp, file, pid: 222, started: 9 }), { code: 'locked' });
  await owner.release();
});

test('a core that cannot say records the estimate, and the format stays a pid and a start', async () => {
  const estimate = Date.now() - process.uptime() * 1000;
  const failed = await ownProcess(async () => null);
  assert.deepEqual(Object.keys(failed), ['pid', 'started']);
  assert.equal(failed.pid, process.pid);
  assert.ok(Math.abs(failed.started - estimate) < 1000, String(failed.started));
  assert.deepEqual(await ownProcess(async () => 1234.5), { pid: process.pid, started: 1235 });
  const file = path.join(scratch(), 'estimated.lock');
  const lock = await acquireLock({ fs: fsp, file, startOf: async () => null });
  const written = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(written), ['pid', 'started']);
  assert.ok(Math.abs(written.started - estimate) < 1000, String(written.started));
  await lock.release();
});

test("the real checks: this process runs and its start time is the kernel's; a pid far above the limit does neither", async () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
  const s = await processStart(process.pid);
  assert.ok(s !== null && Math.abs(s - (Date.now() - process.uptime() * 1000)) < START_SLACK);
  assert.equal(await processStart(2 ** 30), null);
  // the defaults: this process takes and releases a lock, and a second take in this process is refused
  const file = path.join(scratch(), 'self.lock');
  const mine = await acquireLock({ fs: fsp, file });
  await assert.rejects(acquireLock({ fs: fsp, file }), { code: 'locked' });
  await mine.release();
});
