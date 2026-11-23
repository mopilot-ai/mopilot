// Search aliases for MoMo's saved facts (electron/momo/factAliases.cjs, #2999 P2): a fact saved in one language is found
// by a question in the other through terms kept beside it, never in it (nothing that returns a fact carries them); the
// terms belong to the text they were written for, so an update makes them stop matching and asks for new ones; entries
// of facts no longer kept go; a reset or MoMo going off mid-write sets nothing; the alias writer
// (historyAliases.cjs) does saved facts before past chats, one batch at a time, within the same budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, src } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const { MemoryStore } = require('../electron/momo/memory.cjs');
const { rankFacts } = require('../electron/momo/memoryFacts.cjs');
const { createFactAliases, digestOf, FILE } = require('../electron/momo/factAliases.cjs');
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');
const { createHistoryAliases } = require('../electron/momo/historyAliases.cjs');

/** A real memory store with its fact aliases, in a scratch folder. */
function world(o: { safe?: any; fs?: any } = {}) {
  const dir = path.join(scratch(), 'momo');
  const safe = o.safe ?? fakeSafe();
  let clock = 1_000;
  let n = 0;
  // late bound, as main makes them
  const fa = createFactAliases({ dir, safeStorage: safe, store: () => s, fs: o.fs });
  const s = new MemoryStore({
    dir,
    safeStorage: safe,
    isMomoChat: (id: string) => id === src.chatId,
    now: () => (clock += 1),
    newId: () => `f${++n}`,
    aliases: () => fa.lookup(),
  });
  return { dir, s, fa, file: path.join(dir, FILE) };
}
const texts = (r: any[]) => r.map((f) => f.text);

test('rankFacts matches a fact by its aliases too, and returns the fact as it is', () => {
  const facts = [
    { id: 'a', text: 'User lives in Berlin', source: 'user', createdAt: 1, confidence: 'sure' },
    { id: 'b', text: '用户的牙医是王医生', source: 'user', createdAt: 2, confidence: 'sure' },
  ];
  const aliases: Record<string, string> = { a: '住在 柏林 居住 德国', b: 'dentist Dr. Wang' };
  assert.deepEqual(texts(rankFacts(facts, '我住在哪里', 5, 10)), [], 'keyword alone misses');
  assert.deepEqual(texts(rankFacts(facts, '我住在哪里', 5, 10, (f: any) => aliases[f.id])), ['User lives in Berlin']);
  assert.deepEqual(texts(rankFacts(facts, 'who is my dentist', 5, 10, (f: any) => aliases[f.id])), ['用户的牙医是王医生']);
  assert.ok(!JSON.stringify(rankFacts(facts, 'dentist', 5, 10, (f: any) => aliases[f.id])).includes('Wang'), 'never returned');
});

test('rankFacts weighs a word by how rare it is: one rare match outranks several common ones', () => {
  const f = (id: string, text: string, createdAt: number) => ({ id, text, source: 'user', createdAt, confidence: 'sure' });
  const facts = [
    f('b', 'User is born in March; birthday party at home', 1),
    ...Array.from({ length: 9 }, (_, i) => f(`c${i}`, `User is fine when my day ${i} goes well`, 10 + i)),
  ];
  // "is", "my" and "when" are in most facts, "birthday" in one: counted alike, any of the others would come first
  assert.equal(rankFacts(facts, 'When is my birthday', 1, 10)[0].id, 'b');
  assert.deepEqual(rankFacts(facts, 'qwerty', 5, 10), [], 'a word no fact has matches nothing');
});

test('a fact found by a question in the other language once its aliases are set; they are sealed beside it', async () => {
  const w = world();
  assert.equal(w.fa.source.available(), true, 'no file yet: nothing to read, nothing wrong');
  await w.s.save({ text: 'User lives in Berlin', source: src });
  await w.s.save({ text: '用户的牙医是王医生', source: 'user' });
  assert.deepEqual(w.s.search('我住在哪里').length, 0);
  const need = w.fa.source.needing(10);
  assert.deepEqual(
    need.map((i: any) => [i.key, i.text]),
    [
      ['f2', '用户的牙医是王医生'],
      ['f1', 'User lives in Berlin'],
    ],
    'newest first',
  );
  assert.equal(need[1].of, digestOf('user  lives in BERLIN'), 'the digest ignores case and spacing');
  assert.equal(w.fa.source.needing(1).length, 1);
  assert.match(w.fa.source.prompt(need), /\[1\] 用户的牙医是王医生\n\[2\] User lives in Berlin/);
  assert.equal(
    await w.fa.source.set([
      { item: need[1], aliases: '住在 柏林 居住' },
      { item: need[0], aliases: '' },
    ]),
    2,
  );
  assert.deepEqual(texts(w.s.search('我住在哪里')), ['User lives in Berlin']);
  assert.deepEqual(w.fa.source.needing(10), [], "'' marks a fact tried with none");
  // the memory a turn is given ranks by them too, and never shows them
  const summary = w.s.summary({ query: '住在哪' });
  assert.match(summary.facts[0], /User lives in Berlin/, 'the related fact first');
  assert.ok(!JSON.stringify(summary).includes('柏林'));
  // what returns a fact never carries them
  assert.ok(!JSON.stringify(w.s.list()).includes('柏林'));
  assert.ok(!fs.readFileSync(w.file, 'utf8').includes('柏林'), 'sealed on disk');
});

test('an updated fact’s old aliases stop matching and it is asked for again; a fact changed mid-batch is skipped', async () => {
  const w = world();
  const { fact } = await w.s.save({ text: 'User lives in Berlin', source: 'user' });
  const [item] = w.fa.source.needing(5);
  await w.fa.source.set([{ item, aliases: '柏林' }]);
  assert.equal(w.fa.lookup()(fact), '柏林');
  await w.s.update(fact.id, { text: 'User lives in Lisbon' });
  const now = w.s.list().facts[0];
  assert.equal(w.fa.lookup()(now), '', 'written for another text');
  assert.deepEqual(w.s.search('柏林'), []);
  assert.deepEqual(
    w.fa.source.needing(5).map((i: any) => i.text),
    ['User lives in Lisbon'],
  );
  // a batch written for the old text lands after the update: skipped
  assert.equal(await w.fa.source.set([{ item, aliases: 'stale' }]), 0);
  assert.equal(w.fa.lookup()(now), '');
});

test('entries of facts no longer kept go on the next write; a reset or MoMo off mid-batch sets nothing', async () => {
  const w = world();
  const a = (await w.s.save({ text: 'Likes tea', source: 'user' })).fact;
  const b = (await w.s.save({ text: 'Likes chess', source: 'user' })).fact;
  const [ib, ia] = w.fa.source.needing(5);
  await w.fa.source.set([
    { item: ia, aliases: '茶' },
    { item: ib, aliases: '象棋' },
  ]);
  await w.s.forget(a.id);
  assert.equal(await w.fa.source.set([{ item: ib, aliases: '国际象棋' }], () => false), 0, 'not current: nothing set');
  assert.equal(w.fa.lookup()(b), '象棋');
  await w.fa.source.set([{ item: ib, aliases: '国际象棋' }]);
  const { SealedJson } = require('../electron/gateway/sealedFile.cjs');
  const kept = new SealedJson({ file: w.file, safeStorage: fakeSafe(), shape: (v: any) => v }).read();
  assert.deepEqual(Object.keys(kept), [b.id], 'the forgotten fact’s entry went');
  assert.equal(w.fa.lookup()(b), '国际象棋');
});

test('a file that can’t be read: no aliases match and none are written; odd entries are left out', async () => {
  const w = world();
  const { fact } = await w.s.save({ text: 'Likes tea', source: 'user' });
  await w.fa.source.set([{ item: w.fa.source.needing(1)[0], aliases: '茶' }]);
  // sealed with another key
  const other = world({
    safe: {
      ...fakeSafe(),
      decryptString: () => {
        throw new Error('another key');
      },
    },
  });
  fs.mkdirSync(path.dirname(other.file), { recursive: true });
  fs.copyFileSync(w.file, other.file);
  assert.equal(other.fa.lookup()(fact), '');
  assert.equal(other.fa.source.available(), false, 'never sends every fact again each tick');
  assert.deepEqual(other.fa.source.needing(5), []);
  // no encryption: the memory itself is off
  const off = world({ safe: { ...fakeSafe(), isEncryptionAvailable: () => false } });
  assert.equal(off.fa.source.available(), false);
  // entries of another shape count as none
  const { SealedJson } = require('../electron/gateway/sealedFile.cjs');
  const odd = world();
  const f2 = (await odd.s.save({ text: 'Likes tea', source: 'user' })).fact;
  await new SealedJson({ file: odd.file, safeStorage: fakeSafe(), shape: (v: any) => v ?? {} }).change((v: any) => {
    v[f2.id] = { of: digestOf('Likes tea'), aliases: 7 };
    v.x = null;
  });
  assert.equal(odd.fa.lookup()(f2), '');
  assert.equal(odd.fa.source.needing(5).length, 1);
  await new SealedJson({ file: odd.file, safeStorage: fakeSafe(), shape: (v: any) => v ?? {} }).change((v: any) => {
    for (const k of Object.keys(v)) delete v[k];
    v.list = [];
  });
  const arr = world();
  fs.mkdirSync(path.dirname(arr.file), { recursive: true });
  fs.copyFileSync(odd.file, arr.file);
  assert.equal(arr.fa.lookup()(f2), '');
});

test('one search reads the alias file once, whatever the number of facts, and again only when it changed', async () => {
  let stats = 0;
  const w = world({
    fs: {
      statSync: (...a: any[]) => {
        stats++;
        return (fs.statSync as any)(...a);
      },
    },
  });
  for (const t of ['Likes tea', 'Likes chess', 'Likes jazz', 'Likes hiking']) await w.s.save({ text: t, source: 'user' });
  await w.fa.source.set(w.fa.source.needing(5).map((item: any) => ({ item, aliases: item.text === 'Likes tea' ? '喝茶 绿茶' : '' })));
  const { SealedJson } = require('../electron/gateway/sealedFile.cjs');
  const read = SealedJson.prototype.read;
  let reads = 0;
  SealedJson.prototype.read = function (...a: any[]) {
    reads++;
    return read.apply(this, a);
  };
  try {
    stats = 0;
    assert.deepEqual(texts(w.s.search('喝茶')), ['Likes tea']);
    assert.equal(stats, 1, 'one stat for four facts');
    for (let i = 0; i < 4; i++) w.s.search('喝茶');
    assert.equal(reads, 1, 'read once, then from the cache');
    await w.fa.source.set([]);
    w.s.search('喝茶');
    assert.equal(reads, 3, 'a write (its own read) is read again by the next search');
  } finally {
    SealedJson.prototype.read = read;
  }
});

test('a source that fails to say what needs aliases is skipped: past chats still get theirs', async () => {
  const ix = new HistoryIndex({ dir: '/nonexistent', safeStorage: null });
  ix.add([{ chatId: 'c1', turnId: 't1', at: 1, harness: 'claude', kind: 'main', user: 'Bob rents me the flat', assistant: 'ok' }]);
  const sent: any[] = [];
  const broken = {
    name: 'facts',
    available: () => true,
    needing: () => {
      throw new Error('facts unreadable');
    },
    prompt: () => '',
    set: () => 0,
  };
  const off = { ...broken, name: 'off', available: () => false };
  const writer = createHistoryAliases({
    index: ix,
    sources: [off, broken],
    allowed: () => true,
    brain: async () => ({ harness: 'claude' }),
    atLimit: () => false,
    startChat: async () => 'a1',
    send: async (id: string, text: string) => void sent.push([id, text]),
    discardChat: () => {},
    budget: { spend: async () => {}, left: () => 1e9 },
  });
  assert.equal(await writer.tick(), true);
  assert.match(sent[0][1], /chat turn/);
});

test('the alias writer does saved facts first, then past chats, one batch at a time, in the same budget', async () => {
  const w = world();
  await w.s.save({ text: 'User lives in Berlin', source: 'user' });
  const ix = new HistoryIndex({ dir: '/nonexistent', safeStorage: null });
  ix.add([{ chatId: 'c1', turnId: 't1', at: 1, harness: 'claude', kind: 'main', user: 'Bob rents me the flat', assistant: 'ok' }]);
  const sent: any[] = [];
  const spent: [string, number][] = [];
  let n = 0;
  let on = true;
  const writer = createHistoryAliases({
    index: ix,
    sources: [w.fa.source],
    allowed: () => on,
    brain: async () => ({ harness: 'claude' }),
    atLimit: () => false,
    startChat: async () => `a${++n}`,
    send: async (id: string, text: string) => void sent.push([id, text]),
    discardChat: () => {},
    budget: { spend: async (k: string, t: number) => void spent.push([k, t]), left: () => 1e9 },
  });
  assert.equal(await writer.tick(), true);
  assert.match(sent[0][1], /fact about the user/);
  assert.equal(await writer.tick(), false, 'one batch at a time, across sources');
  assert.equal(await writer.finished({ chatId: 'a1', text: '{"1":"住在 柏林"}' }), 1);
  assert.deepEqual(texts(w.s.search('住在哪')), ['User lives in Berlin']);
  assert.equal(await writer.tick(), true, 'facts done: past chats next');
  assert.match(sent[1][1], /chat turn/);
  assert.equal(await writer.finished({ chatId: 'a2', text: '{"1":"landlord 房东"}' }), 1);
  assert.ok(spent.every(([k]) => k === 'aliases'));
  // MoMo goes off while a facts batch is being written: nothing is set
  await w.s.save({ text: 'Likes chess', source: 'user' });
  assert.equal(await writer.tick(), true);
  const landing = writer.finished({ chatId: 'a3', text: '{"1":"象棋"}' });
  on = false;
  assert.equal(await landing, 0);
  assert.deepEqual(w.s.search('象棋'), []);
});
