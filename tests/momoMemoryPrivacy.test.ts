// MoMo's memory stays MoMo's (#2139, electron/momo/memory.cjs, electron/momo/memoryFacts.cjs): encrypted at rest with the injected safeStorage and never written in plain text, off when encryption is unavailable, a tampered fact or document never taken for data, a fact only from a MoMo chat or the user, and the store touching nothing but its own four files (the change log included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, sealed, scratch, src, momoStore } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const { MemoryStore, FACTS_FILE, FILES, UNAVAILABLE, isFact } = require('../electron/momo/memory.cjs');
const { sourceOf, isSource } = require('../electron/momo/memoryFacts.cjs');
const { CHANGES_FILE } = require('../electron/momo/memoryLog.cjs');

const filesOf = (dir: string) => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

test('every document and fact is encrypted on disk and reads back as written', async () => {
  const { s, safe } = momoStore();
  await s.save({ text: 'Allergic to peanuts', source: src, confidence: 'sure' });
  await s.writeFile('aboutYou', 'Du, Berlin');
  await s.writeFile('persona', 'Warm and brief');
  for (const text of filesOf(s.dir))
    for (const secret of ['peanuts', 'Berlin', 'Warm', 'momo-main']) assert.ok(!text.includes(secret), secret);
  // one encrypted line per fact
  const line = fs.readFileSync(path.join(s.dir, FACTS_FILE), 'utf8').trim();
  assert.equal(JSON.parse(safe.decryptString(Buffer.from(line, 'base64'))).text, 'Allergic to peanuts');
  assert.equal(s.list().facts[0].text, 'Allergic to peanuts');
  assert.equal(s.readFile('aboutYou'), 'Du, Berlin');
  assert.equal(s.readFile('persona'), 'Warm and brief');
  await s.writeFile('persona', '');
  assert.equal(s.readFile('persona'), '', 'an emptied document reads as empty');
  for (const f of [FACTS_FILE, FILES.aboutYou, FILES.persona]) assert.equal(fs.statSync(path.join(s.dir, f)).mode & 0o777, 0o600, f);
  // a folder that was there already, open to others, is made owner-only on the next write
  const open = path.join(scratch(), 'momo');
  fs.mkdirSync(open, { mode: 0o755 });
  fs.chmodSync(open, 0o755);
  const { s: t } = momoStore({ dir: open });
  await t.save({ text: 'x', source: src });
  assert.equal(fs.statSync(open).mode & 0o777, 0o700);
});

test('without encryption nothing is read or written, never plain text, and the store says so', async () => {
  for (const safe of [
    null,
    { ...fakeSafe(), isEncryptionAvailable: () => false },
    {
      ...fakeSafe(),
      isEncryptionAvailable: () => {
        throw new Error('no keychain');
      },
    },
  ]) {
    const dir = path.join(scratch(), 'momo');
    const s = new MemoryStore({ dir, safeStorage: safe, isMomoChat: () => true });
    assert.equal(s.available(), false);
    assert.throws(
      () => s.list(),
      (e: any) => e.code === 'unavailable' && e.message === UNAVAILABLE,
    );
    assert.throws(() => s.search('x'), /can't encrypt/);
    assert.throws(() => s.readFile('aboutYou'), /can't encrypt/);
    assert.throws(() => s.summary(), /can't encrypt/);
    await assert.rejects(s.save({ text: 'x', source: src }), (e: any) => e.code === 'unavailable');
    await assert.rejects(s.writeFile('aboutYou', 'x'), (e: any) => e.code === 'unavailable');
    await assert.rejects(s.update('f1', { text: 'x' }), (e: any) => e.code === 'unavailable');
    await assert.rejects(s.forget('f1'), (e: any) => e.code === 'unavailable');
    assert.equal(fs.existsSync(dir), false, 'nothing written');
  }
  // the key goes away between the check and the write: the save fails, the file stays as it was
  const { s, safe } = momoStore();
  await s.save({ text: 'first', source: src });
  const before = fs.readFileSync(path.join(s.dir, FACTS_FILE), 'utf8');
  safe.failEncrypt = true;
  await assert.rejects(s.save({ text: 'second', source: src }), (e: any) => e.code === 'unavailable');
  await assert.rejects(s.writeFile('persona', 'p'), (e: any) => e.code === 'unavailable');
  assert.equal(fs.readFileSync(path.join(s.dir, FACTS_FILE), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(s.dir, FILES.persona)), false);
});

test('a tampered or foreign-key fact is skipped and kept as it was; plain text is never read as a fact', async () => {
  const { s, safe } = momoStore();
  await s.save({ text: 'Real fact', source: src });
  const file = path.join(s.dir, FACTS_FILE);
  const good = fs.readFileSync(file, 'utf8').trim();
  const flipped = Buffer.from(good, 'base64');
  flipped[0] ^= 1;
  const plain = JSON.stringify({ id: 'p1', text: 'Planted fact', source: src, createdAt: 1, confidence: 'sure' });
  const foreign = fakeSafe();
  const other = sealed({ ...foreign, encryptString: (t: string) => Buffer.from(`other:${t}`) } as any, plain);
  fs.writeFileSync(file, [good, flipped.toString('base64'), plain, other, '%%%'].join('\n') + '\n');
  assert.deepEqual(
    s.list().facts.map((f: any) => f.text),
    ['Real fact'],
  );
  assert.equal(s.list().unreadable, 4);
  await s.save({ text: 'Another', source: src });
  const kept = fs.readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(kept.slice(1, 5), [flipped.toString('base64'), plain, other, '%%%']);
  assert.equal(JSON.parse(safe.decryptString(Buffer.from(kept[5], 'base64'))).text, 'Another');
});

test("a document that can't be decrypted fails its read, is left out of the summary, and is kept before it is replaced", async () => {
  const { s } = momoStore();
  await s.save({ text: 'Still here', source: src });
  const file = path.join(s.dir, FILES.aboutYou);
  fs.writeFileSync(file, 'tampered');
  assert.throws(
    () => s.readFile('aboutYou'),
    (e: any) => e.code === 'unreadable' && /about-you\.md can't be decrypted/.test(e.message),
  );
  assert.deepEqual(s.summary(), { persona: '', aboutYou: '', facts: ['- Still here (likely)'] }, 'the facts still go');
  await s.writeFile('aboutYou', 'New text');
  assert.equal(fs.readFileSync(`${file}.unreadable-1000`, 'utf8'), 'tampered');
  assert.equal(s.readFile('aboutYou'), 'New text');
  // a second unreadable one gets a copy of its own; the first stays
  fs.writeFileSync(file, 'tampered again');
  await s.writeFile('aboutYou', 'Newer');
  assert.equal(fs.readFileSync(`${file}.unreadable-1000`, 'utf8'), 'tampered');
  assert.equal(fs.readFileSync(`${file}.unreadable-1000-2`, 'utf8'), 'tampered again');
  // any other failure to keep the copy fails the write, so nothing is lost
  fs.writeFileSync(file, 'tampered once more');
  const blocked = new MemoryStore({
    dir: s.dir,
    safeStorage: fakeSafe(),
    fs: {
      ...fs,
      copyFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    } as any,
  });
  await assert.rejects(blocked.writeFile('aboutYou', 'x'), /EACCES/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered once more');
  // after a hundred taken names it gives up rather than spin, and nothing is replaced
  let tries = 0;
  const crowded = new MemoryStore({
    dir: s.dir,
    safeStorage: fakeSafe(),
    fs: {
      ...fs,
      copyFileSync: () => {
        tries++;
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      },
    } as any,
  });
  await assert.rejects(crowded.writeFile('aboutYou', 'x'), /No free name for a copy/);
  assert.equal(tries, 100);
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered once more');
  // a summary read that fails otherwise still fails
  const broken = new MemoryStore({
    dir: s.dir,
    safeStorage: fakeSafe(),
    fs: {
      ...fs,
      readFileSync: (p: string, e: any) => {
        if (p.endsWith(FILES.persona)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return fs.readFileSync(p, e);
      },
    } as any,
  });
  assert.throws(() => broken.summary(), /EIO/);
});

test('a fact comes only from a MoMo chat or from the user; anything else is refused and nothing is written', async () => {
  const { s } = momoStore();
  for (const source of [
    undefined,
    null,
    '',
    'codex',
    'claude-memory',
    'computer-history',
    'USER',
    { chatId: 'coding-chat', harness: 'claude' },
    { chatId: '', harness: 'claude' },
    { chatId: 42, harness: 'codex' },
    { harness: 'codex' },
    ['momo-main'],
  ])
    await assert.rejects(s.save({ text: 'x', source: source as any }), /only from a MoMo chat or from you/, JSON.stringify(source));
  assert.equal(fs.existsSync(s.dir), false);
  assert.deepEqual((await s.save({ text: 'Typed by me', source: 'user' })).fact.source, 'user');
  assert.deepEqual((await s.save({ text: 'From MoMo', source: src })).fact.source, src);
  assert.deepEqual(
    sourceOf({ chatId: 'momo-main', harness: 7 }, () => true),
    { chatId: 'momo-main', harness: '7' },
  );
  // and a stored fact with any other source is not a fact
  const base = { id: 'a', text: 't', createdAt: 1, confidence: 'sure' };
  for (const bad of ['codex', null, {}, { chatId: '', harness: 'x' }, { chatId: 'c' }, { chatId: 'c', harness: 1 }])
    assert.equal(isFact({ ...base, source: bad }), false, JSON.stringify(bad));
  assert.equal(isFact({ ...base, source: 'user' }), true);
  assert.equal(isSource({ chatId: 'c', harness: '' }), true);
});

test('the store touches only its own four files under its folder, and loads nothing that reads chats or other memories', async () => {
  const root = scratch();
  // what sits next to it is never read: a coding chat, a harness's own memory, Computer History
  for (const [f, text] of [
    ['threads/chat-1.json', '{"secret":"coding"}'],
    ['CLAUDE.md', 'remember: coding'],
    ['.codex/memories/m.md', 'codex memory'],
    ['computer-history/days/2026-10-22', 'history'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const touched: string[] = [];
  const spy = new Proxy(fs, {
    get(target: any, key: string) {
      const v = target[key];
      return typeof v === 'function' && /Sync$/.test(key)
        ? (...args: any[]) => (typeof args[0] === 'string' && touched.push(args[0]), v.apply(target, args))
        : v;
    },
  });
  const dir = path.join(root, 'momo');
  const { s } = momoStore({ dir, fs: spy });
  await s.save({ text: 'a', source: src });
  await s.update('f1', { text: 'b' });
  await s.writeFile('aboutYou', 'x');
  await s.writeFile('persona', 'y');
  s.list();
  s.search('b');
  s.summary();
  await s.forget('f1');
  assert.ok(touched.length > 0);
  for (const p of touched) assert.ok(p === dir || p.startsWith(dir + path.sep), p);
  assert.deepEqual(
    [...new Set(touched.map((p) => path.basename(p)).filter((b) => !b.endsWith('.tmp') && b !== 'momo'))].sort(),
    [FILES.aboutYou, CHANGES_FILE, FACTS_FILE, FILES.persona].sort(),
  );
  // its modules require only the fs port, crypto and the shared write and encryption helpers
  const requires = (file: string) => [...fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires('electron/momo/memory.cjs'), [
    '../platform/encryptedStore.cjs',
    '../platform/fsutil.cjs',
    '../platform/ports/fs.cjs',
    './memoryFacts.cjs',
    './memoryLog.cjs',
    'node:crypto',
    'node:events',
    'node:path',
  ]);
  assert.deepEqual(requires('electron/momo/memoryFacts.cjs'), ['../../shared/textPrefix.mjs']);
  assert.deepEqual(requires('electron/momo/memoryLog.cjs'), ['./memoryFacts.cjs']);
});
