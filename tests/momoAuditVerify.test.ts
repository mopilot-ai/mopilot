// MoMo's audit log, reading (#2139, electron/momo/audit.cjs): verify() names the first broken entry for every kind of tampering, checks across rotated files and refuses without its key; the export is the log as written; intents a quit left open are found and settled as uncertain, never retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act, afterCrash, auditLog, fakeSafe } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { GENESIS, CURRENT, KEY_FILE, HEAD_FILE } = require('../electron/momo/audit.cjs');
const { canonical } = require('../electron/momo/canonical.cjs');

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
/** An entry re-signed with the real key, as someone holding the key could. */
const resign = (key: Buffer, e: any) => {
  const { mac: _m, ...rest } = e;
  return { ...rest, mac: crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex') };
};

test('verify names the first broken entry: an edited field, a forged HMAC, a removed or reordered line, a wrong link, a torn end, an unreadable line', async () => {
  const make = async () => {
    const t = auditLog();
    for (let i = 0; i < 4; i++) await t.log.refusal({ ...act, decision: `d${i}` });
    return { ...t, entries: lines(t.dir) };
  };
  {
    const { log, dir, entries } = await make();
    entries[2].decision = 'asked:30d';
    writeLines(dir, entries);
    assert.deepEqual(await log.verify(), { ok: false, entries: 2, file: CURRENT, line: 3, reason: 'mac' });
  }
  {
    // without the key a plain hash can't stand in for the HMAC
    const { log, dir, entries } = await make();
    const { mac: _m, ...rest } = entries[1];
    entries[1] = {
      ...rest,
      decision: 'x',
      mac: crypto
        .createHash('sha256')
        .update(canonical({ ...rest, decision: 'x' }))
        .digest('hex'),
    };
    writeLines(dir, entries);
    assert.equal(((await log.verify()) as any).reason, 'mac');
    entries[1].mac = 'not hex';
    writeLines(dir, entries);
    assert.equal(((await log.verify()) as any).reason, 'mac');
  }
  {
    const { log, dir, entries } = await make();
    writeLines(dir, [entries[0], entries[2], entries[3]]);
    assert.deepEqual(await log.verify(), { ok: false, entries: 1, file: CURRENT, line: 2, reason: 'gap' });
    writeLines(dir, [entries[0], entries[2], entries[1], entries[3]]);
    assert.equal(((await log.verify()) as any).reason, 'gap');
  }
  {
    // even with the key, a line moved into another chain breaks its link
    const { log, dir, entries, safe } = await make();
    const key = keyOf(dir, safe);
    writeLines(dir, [entries[0], resign(key, { ...entries[1], prev: GENESIS }), entries[2]]);
    assert.deepEqual(await log.verify(), { ok: false, entries: 1, file: CURRENT, line: 2, reason: 'link' });
    writeLines(dir, [resign(key, { ...entries[0], prev: 'f'.repeat(64) })]);
    assert.deepEqual(
      await log.verify(),
      { ok: false, entries: 0, file: CURRENT, line: 1, reason: 'link' },
      'the first entry starts from genesis',
    );
    // an entry number that isn't a whole number
    writeLines(dir, [{ ...entries[0], seq: 1.5 }]);
    assert.equal(((await log.verify()) as any).reason, 'unreadable');
    // a number JSON reads as Infinity can't have been written by the log
    fs.writeFileSync(path.join(dir, CURRENT), `${JSON.stringify(entries[0]).replace('"v":1', '"v":1e400')}\n`);
    assert.equal(((await log.verify()) as any).reason, 'mac');
  }
  {
    const { log, dir } = await make();
    const file = path.join(dir, CURRENT);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -20));
    assert.deepEqual(await log.verify(), { ok: false, entries: 3, file: CURRENT, line: 4, reason: 'torn' });
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').split('\n')[0]}\n\n`);
    assert.deepEqual(await log.verify(), { ok: false, entries: 1, file: CURRENT, line: 2, reason: 'unreadable' });
    fs.writeFileSync(file, '[1,2]\n');
    assert.equal(((await log.verify()) as any).reason, 'unreadable');
  }
  assert.deepEqual(await auditLog().log.verify(), { ok: true, entries: 0, from: 0, last: 0 }, 'an empty log checks out');
});

test('verify checks across rotated files, sees a removed file as a gap, and refuses without its key; the export is the log as written', async () => {
  const { log, dir } = auditLog({ maxBytes: 600 });
  for (let i = 0; i < 9; i++) await log.refusal({ ...act, decision: `d${i}` });
  assert.deepEqual(await log.verify(), { ok: true, entries: 9, from: 1, last: 9 });
  const exported = await log.exportJsonl();
  assert.deepEqual(
    exported
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l).seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const pruned = auditLog({ maxBytes: 600, maxFiles: 2 });
  for (let i = 0; i < 9; i++) await pruned.log.refusal({ ...act, decision: `d${i}` });
  const v = await pruned.log.verify();
  assert.equal(v.ok, true);
  assert.ok(v.from > 1, 'the chain checks from the oldest file still there');
  fs.rmSync(path.join(dir, 'audit.000002.jsonl'));
  assert.equal(((await log.verify()) as any).reason, 'gap');
  // without encryption, or with a key that can't be read, nothing is checked
  const safe = fakeSafe();
  const off = auditLog({ safe });
  await off.log.refusal(act);
  safe.available = false;
  await assert.rejects(off.log.verify(), { code: 'unavailable' });
  safe.available = true;
  fs.writeFileSync(path.join(off.dir, KEY_FILE), 'garbage');
  await assert.rejects(afterCrash({ dir: off.dir }).log.verify(), { code: 'key' });
});

test('an uncertain outcome is kept as it is; an intent without an outcome after a quit is settled as uncertain, never retried', async () => {
  const { log, dir, safe } = auditLog();
  const a = await log.intent(act);
  await log.outcome(a.id, { result: 'uncertain' });
  await assert.rejects(log.outcome(a.id, { result: 'done' }), { code: 'input' }, 'one outcome per intent');
  const b = await log.intent({ ...act, decision: 'remembered:30d' });
  await assert.rejects(log.outcome(b.id, { result: 'maybe' }), { code: 'input' });
  await assert.rejects(log.outcome(b.id, { result: 'done', note: 'x'.repeat(501) }), { code: 'input' });
  await assert.rejects(log.outcome(b.id, undefined as any), { code: 'input' });
  assert.deepEqual(await log.unfinished(), [], 'an intent still running in this process is not unfinished');
  // the app quits while b runs; the next start finds it
  const next = afterCrash({ dir, safe });
  fs.appendFileSync(path.join(dir, CURRENT), '');
  const open = await next.log.unfinished();
  assert.deepEqual(open, [{ id: b.id, action: 'mail_send', chatId: 'momo-main', harness: 'claude', account: 'work', at: 1000 }]);
  assert.equal(await next.log.settleUnfinished(), 1);
  assert.deepEqual(await next.log.unfinished(), []);
  const settled = lines(dir).at(-1);
  assert.deepEqual([settled.kind, settled.id, settled.result], ['outcome', b.id, 'uncertain']);
  assert.equal(lines(dir).filter((e) => e.kind === 'intent').length, 2, 'no intent written again: nothing retried');
  assert.equal((await next.log.verify()).ok, true);
  // unreadable lines and lines without an id are skipped while looking
  fs.appendFileSync(path.join(dir, CURRENT), `junk\n{"kind":"intent"}\n${JSON.stringify({ ...lines(dir)[0], id: 'forged' })}\n`);
  assert.deepEqual(await next.log.unfinished(), []);
  await assert.rejects(log.outcome('nope', { result: 'done' }), { code: 'input' });
});

test('the checkpoint shows entries cut from the end: verify says cut, and so does a missing one after the first entry; one that cannot be read is reported as such', async () => {
  const { log, dir, safe } = auditLog();
  for (let i = 0; i < 3; i++) await log.refusal({ ...act, decision: `d${i}` });
  assert.equal((await log.verify()).ok, true);
  const file = path.join(dir, CURRENT);
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.split('\n').slice(0, 2).join('\n') + '\n');
  assert.deepEqual(await log.verify(), { ok: false, entries: 2, file: CURRENT, line: 0, reason: 'cut' });
  fs.writeFileSync(file, whole);
  const head = fs.readFileSync(path.join(dir, HEAD_FILE), 'utf8');
  fs.writeFileSync(path.join(dir, HEAD_FILE), 'tampered');
  assert.equal(((await log.verify()) as any).reason, 'checkpoint', 'unreadable is not the same as cut');
  await assert.rejects(
    afterCrash({ dir, safe }).log.refusal(act),
    (e: any) => e.code === 'corrupt' && /checkpoint can't be read/.test(e.message),
  );
  fs.rmSync(path.join(dir, HEAD_FILE));
  assert.equal(((await log.verify()) as any).reason, 'cut');
  fs.writeFileSync(path.join(dir, HEAD_FILE), safe.encryptString('{"seq":"x"}').toString('base64'));
  assert.equal(((await log.verify()) as any).reason, 'checkpoint', 'a checkpoint that is not one');
  fs.writeFileSync(path.join(dir, HEAD_FILE), head);
  assert.equal((await log.verify()).ok, true);
  // one entry and no checkpoint yet (a crash before it was written) checks out
  const one = auditLog();
  await one.log.refusal(act);
  fs.rmSync(path.join(one.dir, HEAD_FILE));
  assert.equal((await one.log.verify()).ok, true);
  // a checkpoint that can't be read for another reason is the error
  const t = auditLog({
    fs: {
      ...fsp,
      readFile: async (f: string, ...r: any[]) =>
        f.endsWith(HEAD_FILE) ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : (fsp.readFile as any)(f, ...r),
    },
  });
  await assert.rejects(t.log.refusal(act), { code: 'EIO' });
});

test('after rotation removed the oldest files, the oldest kept must link to the last entry a pruned record names', async () => {
  const p = auditLog({ maxBytes: 600, maxFiles: 3 });
  for (let i = 0; i < 12; i++) await p.log.refusal({ ...act, decision: `d${i}` });
  const v = await p.log.verify();
  assert.equal(v.ok, true);
  assert.ok(v.from > 1);
  const oldest = fs
    .readdirSync(p.dir)
    .filter((n) => /^audit\.\d{6}\.jsonl$/.test(n))
    .sort()[0];
  fs.rmSync(path.join(p.dir, oldest));
  const broken: any = await p.log.verify();
  assert.deepEqual([broken.ok, broken.reason, broken.line], [false, 'gap', 1], 'a file removed by hand has no pruned record');
});

test('a missing checkpoint after more than one entry refuses to continue; a checkpoint that could not be sealed is written with the next entry', async () => {
  const { log, dir, safe } = auditLog();
  await log.refusal(act);
  await log.refusal(act);
  await log.close();
  fs.rmSync(path.join(dir, HEAD_FILE));
  await assert.rejects(afterCrash({ dir, safe }).log.refusal(act), (e: any) => e.code === 'corrupt' && /entry unknown/.test(e.message));
  const t = auditLog();
  await t.log.refusal(act);
  t.safe.failEncrypt = true;
  await assert.rejects(t.log.refusal(act), { code: 'unavailable' }, 'the entry is on the disk, its checkpoint is not');
  t.safe.failEncrypt = false;
  await t.log.refusal(act);
  assert.deepEqual(await t.log.verify(), { ok: true, entries: 3, from: 1, last: 3 });
});
