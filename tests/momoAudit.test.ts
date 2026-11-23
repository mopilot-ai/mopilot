// MoMo's audit log, writing (#2139, electron/momo/audit.cjs) on a scratch folder with a fake key: intent and outcome on the disk with modes and no raw arguments, synced before the intent resolves, no key or no encryption refuses instead of writing plain text, concurrent appends and a second writer keep one chain, rotation and pruning, a write cut short removed and recorded, a tampered end never chained past, and wrong fields refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act, afterCrash, auditLog, fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { AuditLog, AuditError, GENESIS, CURRENT, KEY_FILE, LOCK_FILE, HEAD_FILE } = require('../electron/momo/audit.cjs');
const { macMatches } = require('../electron/momo/auditKey.cjs');

const lines = (dir: string, file = CURRENT) =>
  fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const writeLines = (dir: string, entries: any[], file = CURRENT) =>
  fs.writeFileSync(path.join(dir, file), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
/** The log's key, read the way only the app can (through safeStorage). */
const keyOf = (dir: string, safe: any) =>
  Buffer.from(safe.decryptString(Buffer.from(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8').trim(), 'base64')), 'hex');
/** The chain on disk, oldest file first, each entry's HMAC and link to the one before checked with the real key. */
function chain(dir: string, safe: any) {
  const key = keyOf(dir, safe);
  const files = fs
    .readdirSync(dir)
    .filter((n) => /^audit\.\d{6}\.jsonl$/.test(n))
    .sort();
  if (fs.existsSync(path.join(dir, CURRENT))) files.push(CURRENT);
  const all = files.flatMap((f) => lines(dir, f));
  all.forEach((e, i) => {
    assert.ok(macMatches(key, e), `entry ${e.seq} checks out`);
    if (i) assert.deepEqual([e.seq, e.prev], [all[i - 1].seq + 1, all[i - 1].mac], `entry ${e.seq} links to the one before`);
    else if (e.seq === 1) assert.equal(e.prev, GENESIS);
  });
  return { entries: all.length, from: all[0]?.seq ?? 0, last: all.at(-1)?.seq ?? 0 };
}

test('an intent and its outcome land on the disk in a 0700 folder and 0600 files, with a keyed digest instead of the arguments', async () => {
  const { log, dir, safe, tick } = auditLog();
  const { id, seq } = await log.intent(act);
  assert.deepEqual({ id, seq }, { id: 'i1', seq: 1 });
  tick();
  assert.deepEqual(await log.outcome(id, { result: 'done', note: 'Mail accepted this message' }), { seq: 2 });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, CURRENT)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600);
  const raw = fs.readFileSync(path.join(dir, CURRENT), 'utf8') + fs.readFileSync(path.join(dir, KEY_FILE), 'utf8');
  assert.doesNotMatch(raw, /secret plan|ann@example\.com/, 'no raw argument on the disk');
  const [intent, outcome] = lines(dir);
  assert.equal(intent.kind, 'intent');
  assert.equal(intent.prev, GENESIS);
  assert.match(intent.args, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    {
      action: intent.action,
      chatId: intent.chatId,
      harness: intent.harness,
      account: intent.account,
      decision: intent.decision,
      at: intent.at,
    },
    { action: 'mail_send', chatId: 'momo-main', harness: 'claude', account: 'work', decision: 'asked:once', at: 1000 },
  );
  assert.deepEqual(
    {
      kind: outcome.kind,
      id: outcome.id,
      result: outcome.result,
      note: outcome.note,
      action: outcome.action,
      prev: outcome.prev,
      at: outcome.at,
    },
    { kind: 'outcome', id: 'i1', result: 'done', note: 'Mail accepted this message', action: 'mail_send', prev: intent.mac, at: 1001 },
  );
  assert.deepEqual(chain(dir, safe), { entries: 2, from: 1, last: 2 });
  // the same arguments, written in another key order, give the same digest; other arguments another one
  await log.refusal({ ...act, args: { body: 'secret plan', to: 'ann@example.com' }, decision: 'denied' });
  await log.refusal({ ...act, args: { to: 'bob@example.com' }, decision: 'denied' });
  const [, , same, other] = lines(dir);
  assert.equal(same.args, intent.args);
  assert.notEqual(other.args, intent.args);
  assert.equal(same.kind, 'refusal');
  // an action without harness, account or arguments keeps them empty
  await log.refusal({ action: 'x', chatId: 'c', decision: 'blocked' });
  const last = lines(dir).at(-1);
  assert.deepEqual([last.harness, last.account], ['', '']);
});

test('the intent resolves only after its line was synced to the disk', async () => {
  const events: string[] = [];
  const name = (f: string) => (f.endsWith('.tmp') ? (f.includes('audit.head') ? 'head' : 'key') : path.basename(f));
  const watched = {
    ...fsp,
    open: async (...a: any[]) => {
      const fh: any = await (fsp.open as any)(...a);
      return {
        chmod: (m: number) => fh.chmod(m),
        write: async (s: string) => (events.push(`write ${name(a[0])}`), fh.write(s)),
        sync: async () => (events.push(`sync ${name(a[0])}`), fh.sync()),
        close: () => fh.close(),
      };
    },
  };
  const { log } = auditLog({ fs: watched });
  await log.intent(act);
  events.push('resolved');
  assert.deepEqual(
    events,
    [
      'write audit.lock',
      'sync audit.lock',
      'write key',
      'sync key',
      'sync audit',
      'write audit.jsonl',
      'sync audit.jsonl',
      'write head',
      'sync head',
      'sync audit',
      'resolved',
    ],
    'the lock, the key (whole, folder synced), the entry, then its checkpoint',
  );
});

test('without encryption nothing is written, never a plain log; a missing or unreadable key of an existing log refuses too', async () => {
  const safe = fakeSafe();
  safe.available = false;
  const { log, dir } = auditLog({ safe });
  assert.equal(log.available(), false);
  await assert.rejects(log.intent(act), (e: any) => e instanceof AuditError && e.code === 'unavailable');
  await assert.rejects(log.refusal(act), { code: 'unavailable' });
  assert.equal(fs.existsSync(dir), false, 'no folder, no file');
  safe.available = true;
  safe.failEncrypt = true;
  await assert.rejects(log.intent(act), { code: 'unavailable' }, 'the key could not be sealed');
  assert.equal(fs.existsSync(path.join(dir, KEY_FILE)), false);
  safe.failEncrypt = false;
  await log.intent(act);
  assert.equal(log.available(), true, 'the Keychain came back: a later call works');

  const throwing = {
    isEncryptionAvailable: () => {
      throw new Error('no keychain');
    },
  };
  assert.equal(new AuditLog({ dir, safeStorage: throwing }).available(), false);
  assert.equal(new AuditLog({ dir, safeStorage: null }).available(), false);

  const other = auditLog({ dir: path.join(scratch(), 'a') });
  await other.log.intent(act);
  fs.rmSync(path.join(other.dir, KEY_FILE));
  const fresh = afterCrash({ dir: other.dir });
  await assert.rejects(fresh.log.intent(act), { code: 'key' }, 'no new key over an existing log');
  fs.writeFileSync(path.join(other.dir, KEY_FILE), 'garbage');
  await assert.rejects(afterCrash({ dir: other.dir }).log.refusal(act), { code: 'key' });

  // a key file that can't be read for another reason is the error, not a new key
  const denied = {
    ...fsp,
    readFile: async (f: string, ...r: any[]) =>
      f.endsWith(KEY_FILE) ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : (fsp.readFile as any)(f, ...r),
  };
  await assert.rejects(auditLog({ fs: denied }).log.intent(act), { code: 'EACCES' });
  const noList = { ...fsp, readdir: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) };
  await assert.rejects(auditLog({ fs: noList }).log.intent(act), { code: 'EIO' });
  assert.throws(() => new AuditLog({ dir: 'relative', safeStorage: safe }), /absolute folder/);
  const plain = new AuditLog({ dir: path.join(scratch(), 'plain'), safeStorage: fakeSafe() });
  assert.match((await plain.intent(act)).id, /^[0-9a-f-]{36}$/, 'a random id by default');
});

test('concurrent appends keep one unbroken chain, and a new instance continues it', async () => {
  const { log, dir, safe } = auditLog();
  const ids = await Promise.all(Array.from({ length: 25 }, (_, i) => log.intent({ ...act, decision: `d${i}` })));
  assert.deepEqual(
    ids.map((x: any) => x.seq),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  await Promise.all(ids.map((x: any) => log.outcome(x.id, { result: 'done' })));
  assert.deepEqual(chain(dir, safe), { entries: 50, from: 1, last: 50 });
  const next = afterCrash({ dir, safe });
  await next.log.refusal(act);
  assert.deepEqual(chain(dir, safe), { entries: 51, from: 1, last: 51 });
  // a failed append does not stop the queue
  await assert.rejects(log.intent({ ...act, action: '' }), { code: 'input' });
  await log.idle();
});

test('one log holds the folder: a second live one is refused, close() lets the next in, and a log whose lock was taken over still chains from the real end', async () => {
  const { log, dir, safe } = auditLog();
  await log.refusal(act);
  const second = auditLog({ dir, safe });
  await assert.rejects(second.log.refusal(act), { code: 'locked' }, 'a second instance, or a dev instance on the same folder');
  await log.close();
  await second.log.refusal(act);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid, process.pid);
  await second.log.close();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  // a process that crashed holding the lock, while another took over: both writes still chain
  const a = auditLog({ dir, safe, lock: { pid: 1111, isAlive: () => true } });
  await a.log.refusal(act);
  const b = afterCrash({ dir, safe });
  await b.log.refusal(act);
  await a.log.refusal(act);
  assert.deepEqual(chain(dir, safe), { entries: 5, from: 1, last: 5 });
  await a.log.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid, 4242, 'a log never removes a lock it lost');
  await new (auditLog().log.constructor as any)({ dir: path.join(scratch(), 'idle'), safeStorage: safe }).close();
});

test('after a lost key the user can start over: the old log is set aside untouched and a new chain starts by naming it', async () => {
  const { log, dir, safe, tick } = auditLog();
  await log.refusal(act);
  await log.refusal(act);
  await log.close();
  fs.rmSync(path.join(dir, KEY_FILE));
  const next = afterCrash({ dir, safe });
  await assert.rejects(next.log.refusal(act), { code: 'key' });
  tick(5);
  const aside = await next.log.startOver();
  assert.equal(aside, 'set-aside-1000');
  assert.deepEqual(fs.readdirSync(path.join(dir, aside)).sort(), [HEAD_FILE, CURRENT]);
  assert.equal(lines(path.join(dir, aside)).length, 2, 'kept as it was');
  const [restart] = lines(dir);
  assert.deepEqual([restart.seq, restart.kind, restart.note], [1, 'restart', 'The earlier log was set aside in set-aside-1000']);
  await next.log.refusal(act);
  assert.deepEqual(chain(dir, safe), { entries: 2, from: 1, last: 2 });
  const off = fakeSafe();
  off.available = false;
  await assert.rejects(auditLog({ safe: off }).log.startOver(), { code: 'unavailable' });
  const stuck = auditLog({
    fs: {
      ...fsp,
      rename: async (from: string, to: string) =>
        to.includes('set-aside') ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : fsp.rename(from, to),
    },
  });
  await stuck.log.refusal(act);
  await assert.rejects(stuck.log.startOver(), { code: 'EACCES' });
});

test('the log rotates by size, chains across its files, and drops the oldest beyond maxFiles', async () => {
  const { log, dir, safe } = auditLog({ maxBytes: 600 });
  for (let i = 0; i < 9; i++) await log.refusal({ ...act, decision: `d${i}` });
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('audit.') && n.endsWith('.jsonl'))
    .sort();
  assert.ok(files.length >= 3, files.join());
  assert.equal(files.at(-1), CURRENT);
  assert.equal(files[0], 'audit.000001.jsonl');
  assert.deepEqual(chain(dir, safe), { entries: 9, from: 1, last: 9 });

  const pruned = auditLog({ maxBytes: 600, maxFiles: 2 });
  for (let i = 0; i < 9; i++) await pruned.log.refusal({ ...act, decision: `d${i}` });
  const kept = fs.readdirSync(pruned.dir).filter((n) => n.endsWith('.jsonl'));
  assert.equal(kept.length, 2);
  const v = chain(pruned.dir, pruned.safe);
  assert.ok(v.from > 1, 'the oldest files are gone');
  const left = fs
    .readdirSync(pruned.dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => lines(pruned.dir, f));
  const marks = left.filter((e) => e.kind === 'pruned');
  assert.ok(marks.length > 0, 'each removal is recorded');
  assert.deepEqual(
    Object.keys(marks[0]).filter((k) => k.startsWith('last')),
    ['lastSeq', 'lastMac'],
  );
  assert.equal(left.filter((e) => e.kind === 'refusal').at(-1).decision, 'd8');
  // a full current file whose size can't be read is the error
  const statFails = { ...fsp, stat: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) };
  const s = auditLog({ fs: statFails });
  await assert.rejects(s.log.refusal(act), { code: 'EIO' });
});

test('a write cut short is removed from the end and recorded, never chained past; a tampered end refuses to continue', async () => {
  let failNext = false;
  const flaky = {
    ...fsp,
    open: async (...a: any[]) => {
      const fh: any = await (fsp.open as any)(...a);
      return {
        chmod: (m: number) => fh.chmod(m),
        write: async (s: string) => {
          if (!failNext) return fh.write(s);
          failNext = false;
          await fh.write(s.slice(0, 10));
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        },
        sync: () => fh.sync(),
        close: () => fh.close(),
      };
    },
  };
  const { log, dir, safe } = auditLog({ fs: flaky });
  await log.refusal(act);
  failNext = true;
  await assert.rejects(log.refusal(act), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(path.join(dir, CURRENT), 'utf8').endsWith('\n'), false, 'until the next write the cut end stays');
  await log.refusal({ ...act, decision: 'after' });
  assert.deepEqual(chain(dir, safe), { entries: 3, from: 1, last: 3 });
  const [, repair, after] = lines(dir);
  assert.equal(repair.kind, 'repair');
  assert.match(repair.note, /^A write cut short \(\d+ bytes\) was removed from the end$/);
  assert.equal(after.decision, 'after');
  // a new log whose very first write was cut short, before any checkpoint, in a new process
  fs.writeFileSync(path.join(dir, CURRENT), '{"v":1,"seq"');
  fs.rmSync(path.join(dir, HEAD_FILE));
  const fresh = afterCrash({ dir, safe });
  await fresh.log.refusal(act);
  assert.deepEqual(
    lines(dir).map((e) => [e.seq, e.kind]),
    [
      [1, 'repair'],
      [2, 'refusal'],
    ],
  );

  const t = auditLog();
  await t.log.refusal(act);
  const entries = lines(t.dir);
  entries[0].decision = 'forged';
  writeLines(t.dir, entries);
  await assert.rejects(afterCrash({ dir: t.dir, safe: t.safe }).log.refusal(act), { code: 'corrupt' });
  fs.writeFileSync(path.join(t.dir, CURRENT), 'not json\n');
  await assert.rejects(afterCrash({ dir: t.dir, safe: t.safe }).log.refusal(act), { code: 'corrupt' });
  fs.writeFileSync(path.join(t.dir, CURRENT), '');
  // entries cut from the end (an emptied current file after rotation): the checkpoint shows it, and nothing is chained past it
  const r = auditLog({ dir: path.join(scratch(), 'r'), maxBytes: 1 });
  await r.log.refusal(act);
  await r.log.refusal(act);
  fs.writeFileSync(path.join(r.dir, CURRENT), '');
  await assert.rejects(
    afterCrash({ dir: r.dir, safe: r.safe, maxBytes: 1 }).log.refusal(act),
    (e: any) => e.code === 'corrupt' && /cut from the end/.test(e.message),
  );
  // a quit right after rotation moved the current file aside: the end is the last rotated file's
  const q = auditLog({ dir: path.join(scratch(), 'q'), maxBytes: 1 });
  await q.log.refusal(act);
  await q.log.refusal(act);
  await q.log.close();
  fs.renameSync(path.join(q.dir, CURRENT), path.join(q.dir, 'audit.000002.jsonl'));
  const again = auditLog({ dir: q.dir, safe: q.safe, maxBytes: 1 });
  await again.log.refusal(act);
  assert.deepEqual(chain(q.dir, q.safe), { entries: 3, from: 1, last: 3 });
});

test('an entry with wrong fields is refused before anything is written', async () => {
  const { log, dir } = auditLog();
  for (const bad of [
    null,
    { ...act, action: '' },
    { ...act, action: 7 },
    { ...act, chatId: undefined },
    { ...act, decision: 'x'.repeat(201) },
    { ...act, harness: 3 },
    { ...act, args: { f: () => 1 } },
    { ...act, args: { n: Number.NaN } },
  ])
    await assert.rejects(log.intent(bad as any), { code: 'input' }, JSON.stringify(bad));
  assert.equal(fs.existsSync(dir), false);
  const a = await log.intent(act);
  await assert.rejects(log.outcome(a.id, { result: 'maybe' }), { code: 'input' });
  await assert.rejects(log.outcome(a.id, { result: 'done', note: 'x'.repeat(501) }), { code: 'input' });
  await assert.rejects(log.outcome(a.id, undefined as any), { code: 'input' });
  await log.outcome(a.id, { result: 'uncertain' });
  await assert.rejects(log.outcome(a.id, { result: 'done' }), { code: 'input' }, 'one outcome per intent');
  await assert.rejects(log.outcome('nope', { result: 'done' }), { code: 'input' });
  assert.equal(lines(dir).at(-1).result, 'uncertain');
});

test('Reset (#2307): erase() deletes the folder after the queued writes, and the next entry starts a new folder, key and chain', async () => {
  const { log, dir, safe } = auditLog();
  await log.intent(act);
  await log.erase();
  assert.equal(fs.existsSync(dir), false, 'key, lock, checkpoint and log all gone');
  // a read that needs an intent right after, with no restart
  const { seq } = await log.intent(act);
  assert.equal(seq, 1, 'a new chain');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(dir, LOCK_FILE)), 'the folder is held again');
  assert.deepEqual(chain(dir, safe), { entries: 1, from: 1, last: 1 });
  assert.deepEqual(await log.verify(), { ok: true, entries: 1, from: 1, last: 1 });
  await log.close();
});

test('a folder deleted after close() is made again by the next entry', async () => {
  const { log, dir } = auditLog();
  await log.intent(act);
  await log.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal((await log.intent(act)).seq, 1);
  await log.close();
});

test('an intent racing Reset waits for it and lands in the new chain; erase waits for a key still being made', async () => {
  const { log, dir, safe } = auditLog();
  // the first intent makes the key outside the write queue; erase must not delete the folder under it
  const racing = log.intent(act);
  const erased = log.erase();
  const [entry] = await Promise.all([racing, erased]);
  assert.equal(entry.seq, 1);
  assert.deepEqual(chain(dir, safe), { entries: 1, from: 1, last: 1 });
  await log.close();
});

test('an intent asked while erase() deletes the folder waits until it is gone, then starts the new chain', async () => {
  let during: Promise<any> | null = null;
  const fsWrap = {
    ...fsp,
    rm: async (...a: Parameters<typeof fsp.rm>) => {
      // the gap between letting go of the folder and deleting it: a source read asks for an intent now
      during ??= q.log.intent(act);
      await new Promise((r) => setTimeout(r, 5));
      return fsp.rm(...a);
    },
  };
  const q = auditLog({ fs: fsWrap });
  await q.log.intent(act);
  await q.log.erase();
  assert.equal((await during!).seq, 1, 'made after the folder went, in a new chain');
  assert.deepEqual(chain(q.dir, q.safe), { entries: 1, from: 1, last: 1 });
  assert.deepEqual(await q.log.verify(), { ok: true, entries: 1, from: 1, last: 1 });
  await q.log.close();
});
