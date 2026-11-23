// MoMo's memory store (#2139, electron/momo/memory.cjs) on a scratch folder with a fake key: saving with dedupe, search ranking, update and forget, the two documents, the bounded summary, expiry, a corrupt line kept and skipped, an unreadable file never written over, and two saves at once both kept. Encryption, sources and isolation: tests/momoMemoryPrivacy.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, sealed, scratch, src, momoStore as store } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const { MemoryStore, MemoryError, FACTS_FILE, MAX_FACT, MAX_FACTS, MAX_FILE, isFact } = require('../electron/momo/memory.cjs');
const { estimateTokens, clipTokens } = require('../electron/momo/memoryFacts.cjs');
const { CHANGES_FILE } = require('../electron/momo/memoryLog.cjs');
const none = { persona: '', aboutYou: '', facts: [] };
const other = { chatId: 'momo-other', harness: 'codex' };

test('a fact is saved with its source, listed newest first, and the same text is not saved twice', async () => {
  const { s, tick } = store({ momo: ['momo-main', 'momo-other', 'momo-x'] });
  assert.deepEqual(s.list(), { facts: [], unreadable: 0 }, 'no folder yet: nothing kept');
  const a = await s.save({ text: '  Lives in   Berlin ', source: src, confidence: 'sure' });
  assert.deepEqual(a, {
    saved: true,
    fact: { id: 'f1', text: 'Lives in Berlin', source: src, createdAt: 1000, confidence: 'sure' },
  });
  tick();
  const b = await s.save({ text: 'lives in berlin', source: other });
  assert.equal(b.saved, false, 'same text, other case and spacing');
  assert.equal(b.fact.id, 'f1');
  const c = await s.save({ text: 'Has a cat named Miso', source: { chatId: 'momo-x', harness: 'acp:kimi' } });
  assert.equal(c.fact.confidence, 'likely', 'likely unless said otherwise');
  assert.deepEqual(
    s.list().facts.map((f: any) => f.id),
    ['f2', 'f1'],
  );
  // folder 0700, file 0600, and no temporary file left behind
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(s.dir, FACTS_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), [CHANGES_FILE, FACTS_FILE], 'the facts and their change log');
});

test('a save, update or file write with wrong input is refused and changes nothing', async () => {
  const { s } = store();
  for (const input of [
    { text: '' },
    { text: '   ' },
    { text: 42 },
    null,
    { text: 'x'.repeat(MAX_FACT + 1) },
    { text: 'ok', confidence: 'maybe' },
    { text: 'ok', confidence: 3 },
    { text: 'ok', expiresAt: 'tomorrow' },
    { text: 'ok', expiresAt: Number.NaN },
  ])
    await assert.rejects(s.save({ source: src, ...(input as any) }), MemoryError, JSON.stringify(input));
  assert.equal(fs.existsSync(s.dir), false);
  const { fact } = await s.save({ text: 'ok', source: { chatId: 'momo-main' } as any });
  assert.deepEqual(fact.source, { chatId: 'momo-main', harness: '' }, 'a missing harness is kept as empty, never undefined');
  await assert.rejects(s.update(fact.id, { text: '' }), MemoryError);
  await assert.rejects(s.update(fact.id, { confidence: 'no' }), MemoryError);
  await assert.rejects(s.writeFile('aboutYou', 7 as any), /must be a string/);
  await assert.rejects(s.writeFile('aboutYou', 'x'.repeat(MAX_FILE + 1)), /at most/);
  await assert.rejects(s.writeFile('secrets' as any, 'x'), /No such memory file/);
  assert.throws(() => s.readFile('../etc' as any), /No such memory file/);
  assert.throws(() => new MemoryStore({ dir: 'relative', safeStorage: fakeSafe() }), /absolute folder/);
  const bare = new MemoryStore({ dir: path.join(scratch(), 'm'), safeStorage: fakeSafe() });
  await assert.rejects(bare.save({ text: 'ok', source: src }), /only from a MoMo chat or from you/, 'no isMomoChat: no chat counts');
  assert.equal((await bare.save({ text: 'ok', source: 'user' })).fact.id.length, 36, 'a random id by default');
});

test('search ranks by words matched, then sure before likely, then newer; an empty query lists the newest', async () => {
  const { s, tick } = store();
  await s.save({ text: 'Prefers tea over coffee', source: src });
  tick();
  await s.save({ text: 'Drinks coffee every morning', source: src, confidence: 'sure' });
  tick();
  await s.save({ text: 'Works at a coffee roaster in Berlin', source: src });
  tick();
  await s.save({ text: '喜欢 喝茶', source: src });
  assert.deepEqual(
    s.search('Berlin coffee').map((f: any) => f.id),
    ['f3', 'f2', 'f1'],
  );
  assert.deepEqual(
    s.search('coffee').map((f: any) => f.id),
    ['f2', 'f3', 'f1'],
    'a tie: sure first, then newer',
  );
  assert.deepEqual(
    s.search('喝茶').map((f: any) => f.id),
    ['f4'],
  );
  assert.deepEqual(s.search('nothing here'), []);
  assert.deepEqual(
    s.search('', { limit: 2 }).map((f: any) => f.id),
    ['f4', 'f3'],
  );
  assert.equal(s.search(undefined as any, { limit: Number.NaN }).length, 4, 'a bad limit is the default');
  assert.equal(s.search('', { limit: 0.5 }).length, 1, 'at least one');
});

test('update changes text, confidence and expiry (null clears it); forget removes; neither finds a missing id', async () => {
  const { s } = store();
  const { fact } = await s.save({ text: 'Runs on Sundays', source: src, expiresAt: 5000 });
  assert.equal(await s.update('nope', { text: 'x' }), null);
  assert.equal(await s.forget('nope'), null);
  const u = await s.update(fact.id, { text: 'Runs on Saturdays', confidence: 'sure' });
  assert.deepEqual(u, { ...fact, text: 'Runs on Saturdays', confidence: 'sure', expiresAt: 5000 });
  assert.equal((await s.update(fact.id, { expiresAt: 9000 })).expiresAt, 9000);
  const cleared = await s.update(fact.id, { expiresAt: null });
  assert.equal('expiresAt' in cleared, false);
  assert.deepEqual(await s.update(fact.id, null as any), cleared, 'no patch changes nothing');
  assert.deepEqual(await s.forget(fact.id), cleared);
  assert.deepEqual(s.list().facts, []);
});

test('expired facts are left out of search, the summary and the list, unless the list asks for them; the next write prunes them', async () => {
  let now = 1_000;
  const { s } = store({ now: () => now, momo: ['momo-main', 'momo-other'] });
  await s.save({ text: 'Is on a trip to Rome this week', source: src, expiresAt: 2_000 });
  await s.save({ text: 'Likes Rome', source: src });
  assert.equal(s.search('Rome').length, 2);
  now = 2_000;
  assert.deepEqual(
    s.search('Rome').map((f: any) => f.text),
    ['Likes Rome'],
  );
  assert.deepEqual(s.summary().facts, ['- Likes Rome (likely)']);
  assert.equal(s.list().facts.length, 1);
  assert.equal(s.list({ includeExpired: true }).facts.length, 2, 'kept until the next write');
  // the same text again brings the expired fact back under its id, with the new save's details
  const again = await s.save({ text: 'is on a trip to rome this week', source: other, confidence: 'sure' });
  assert.deepEqual(again, {
    saved: true,
    fact: {
      id: 'f1',
      text: 'is on a trip to rome this week',
      source: other,
      createdAt: 2000,
      confidence: 'sure',
    },
  });
  assert.equal(s.list({ includeExpired: true }).facts.length, 2, 'not a second line');
  // an expired fact is gone on the next write; an edit that leaves one expired finds it gone
  await s.save({ text: 'Back from Rome', source: src, expiresAt: 3_000 });
  now = 3_000;
  assert.equal(await s.update('f3', { text: 'Was in Rome' }), null, 'still expired: pruned');
  assert.deepEqual(
    s.list({ includeExpired: true }).facts.map((f: any) => f.id),
    ['f1', 'f2'],
  );
});

test("a save past the cap is refused until some are forgotten; expired facts don't count", async () => {
  let now = 1_000;
  const { s, safe } = store({ now: () => now });
  const file = path.join(s.dir, FACTS_FILE);
  fs.mkdirSync(s.dir, { recursive: true });
  const lines = Array.from({ length: MAX_FACTS }, (_, i) =>
    sealed(
      safe,
      JSON.stringify({
        id: `x${i}`,
        text: `fact ${i}`,
        source: src,
        createdAt: 1,
        confidence: 'likely',
        ...(i === 0 ? { expiresAt: 5_000 } : {}),
      }),
    ),
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  await assert.rejects(
    s.save({ text: 'one more', source: src }),
    (e: any) => e.code === 'full' && e.message.includes(`full (${MAX_FACTS} facts)`),
  );
  assert.equal((await s.save({ text: 'fact 7', source: src })).saved, false, 'a duplicate is no new fact');
  now = 5_000;
  assert.equal((await s.save({ text: 'one more', source: src })).saved, true, 'the expired one made room');
  assert.equal(s.list({ includeExpired: true }).facts.length, MAX_FACTS, 'and was pruned');
});

test('facts are decrypted once per state of the file, and read again when anything changes it', async () => {
  const { s, safe } = store();
  await s.save({ text: 'cached', source: src });
  let opened = 0;
  const decrypt = safe.decryptString;
  safe.decryptString = (b: Buffer) => (opened++, decrypt(b));
  s.list();
  s.search('cached');
  s.summary();
  assert.equal(opened, 1);
  // another writer (another window's store, a restore) changes the file: read again
  const file = path.join(s.dir, FACTS_FILE);
  fs.appendFileSync(
    file,
    `${sealed(safe, JSON.stringify({ id: 'z', text: 'from outside', source: 'user', createdAt: 9, confidence: 'sure' }))}\n`,
  );
  assert.deepEqual(
    s.list().facts.map((f: any) => f.text),
    ['cached', 'from outside'],
  );
  assert.equal(opened, 3);
  // the returned list is a copy: changing it changes nothing kept
  s.list().facts.pop();
  assert.equal(s.list().facts.length, 2);
});

test('a corrupt line is skipped and counted, never fatal, and written back as it was', async () => {
  const { s, safe } = store();
  fs.mkdirSync(s.dir, { recursive: true });
  const good = { id: 'g1', text: 'Speaks German', source: src, createdAt: 5, confidence: 'sure' };
  const lines = [
    sealed(safe, '{not json'),
    sealed(safe, JSON.stringify({ id: 'x', text: 'no source' })),
    sealed(safe, JSON.stringify(good)),
    '',
    sealed(safe, JSON.stringify([1, 2])),
  ];
  fs.writeFileSync(path.join(s.dir, FACTS_FILE), lines.join('\n'));
  assert.deepEqual(s.list(), { facts: [good], unreadable: 3 });
  await s.save({ text: 'Speaks French', source: src });
  const after = fs.readFileSync(path.join(s.dir, FACTS_FILE), 'utf8').split('\n');
  assert.equal(after[0], lines[0]);
  assert.equal(after[1], lines[1]);
  assert.equal(after.length, 6, 'four kept lines, the new fact and the trailing newline');
  assert.equal(s.list().unreadable, 3);
  assert.equal(isFact(null), false);
  assert.equal(isFact({ ...good, expiresAt: 'soon' }), false);
  assert.equal(isFact({ ...good, expiresAt: 7 }), true);
});

test('a facts file that cannot be read fails the read and the save, and is never written over', async () => {
  const { s } = store();
  fs.mkdirSync(path.join(s.dir, FACTS_FILE), { recursive: true });
  assert.throws(() => s.list(), /EISDIR/);
  await assert.rejects(s.save({ text: 'x', source: src }), /EISDIR/);
  assert.ok(fs.statSync(path.join(s.dir, FACTS_FILE)).isDirectory());
  // the queue goes on after a failed write
  fs.rmSync(path.join(s.dir, FACTS_FILE), { recursive: true });
  assert.equal((await s.save({ text: 'x', source: src })).saved, true);
});

test('a write that fails leaves the old file whole and no temporary file', async () => {
  const dir = scratch();
  const { s } = store({ dir });
  await s.save({ text: 'first', source: src });
  const failing = {
    ...fs,
    renameSync: () => {
      throw new Error('disk full');
    },
  };
  const broken = new MemoryStore({ dir, safeStorage: fakeSafe(), isMomoChat: () => true, fs: failing as any });
  await assert.rejects(broken.save({ text: 'second', source: src }), /disk full/);
  assert.deepEqual(
    s.list().facts.map((f: any) => f.text),
    ['first'],
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), [CHANGES_FILE, FACTS_FILE], 'no temporary file, and the log untouched');
  assert.equal(s.changes().length, 1, 'the failed save logged nothing');
});

test('two saves at once are both kept, in the order they were made', async () => {
  const { s, safe } = store();
  const [a, b, c] = await Promise.all([
    s.save({ text: 'one', source: src }),
    s.save({ text: 'two', source: src }),
    s.writeFile('aboutYou', 'Du'),
  ]);
  assert.equal(a.fact.id, 'f1');
  assert.equal(b.fact.id, 'f2');
  assert.equal(c, undefined);
  const raw = fs.readFileSync(path.join(s.dir, FACTS_FILE), 'utf8');
  assert.deepEqual(
    raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(safe.decryptString(Buffer.from(l, 'base64'))).text),
    ['one', 'two'],
  );
  // and the same text twice at once is saved once
  const [x, y] = await Promise.all([s.save({ text: 'three', source: src }), s.save({ text: 'Three', source: src })]);
  assert.deepEqual([x.saved, y.saved], [true, false]);
  assert.equal(y.fact.id, x.fact.id);
  await s.idle();
});

test("every write that reached the disk emits 'changed'; a refused or failed one does not", async () => {
  const { s } = store();
  let n = 0;
  s.on('changed', () => n++);
  const { fact } = await s.save({ text: 'one', source: src });
  await s.save({ text: 'ONE', source: src });
  assert.equal(n, 1, 'a duplicate writes nothing');
  await s.update(fact.id, { confidence: 'sure' });
  await s.writeFile('persona', 'p');
  await s.forget(fact.id);
  assert.equal(n, 4);
  await assert.rejects(s.save({ text: '', source: src }));
  assert.equal(await s.forget('gone'), null);
  fs.rmSync(path.join(s.dir, FACTS_FILE));
  fs.mkdirSync(path.join(s.dir, FACTS_FILE));
  await assert.rejects(s.save({ text: 'two', source: src }));
  assert.equal(n, 4);
});

test('an edit to the text another fact already has is refused, so no two facts say the same', async () => {
  const { s } = store();
  await s.save({ text: 'Lives in Berlin', source: src });
  const { fact } = await s.save({ text: 'Lives in Hamburg', source: src });
  await assert.rejects(s.update(fact.id, { text: 'lives in  berlin' }), /Another fact already says this/);
  assert.equal((await s.update(fact.id, { text: 'Lives in hamburg' })).text, 'Lives in hamburg', 'its own text in other case is fine');
  assert.equal(s.list().facts.length, 2);
});

test('About you and the persona are read and written whole; a missing one reads as empty', async () => {
  const { s } = store();
  assert.equal(s.readFile('aboutYou'), '');
  await s.writeFile('aboutYou', '# Du\nBuilds MoPilot.');
  await s.writeFile('persona', 'Warm, brief.');
  assert.equal(s.readFile('aboutYou'), '# Du\nBuilds MoPilot.');
  assert.equal(s.readFile('persona'), 'Warm, brief.');
  assert.equal(fs.statSync(path.join(s.dir, 'persona.md')).mode & 0o777, 0o600);
});

test('the summary is the persona, about the user, then the most relevant facts, within an estimated token budget', async () => {
  const { s, tick } = store();
  assert.deepEqual(s.summary(), none, 'nothing kept: nothing to say');
  assert.deepEqual(s.summary({ query: null as any }), none, 'no query given: none');
  await s.save({ text: 'Older likely fact', source: src });
  tick();
  await s.save({ text: 'Sure fact', source: src, confidence: 'sure' });
  tick();
  await s.save({ text: 'Newest likely fact about Rome', source: src });
  assert.deepEqual(s.summary(), {
    ...none,
    facts: ['- Sure fact', '- Newest likely fact about Rome (likely)', '- Older likely fact (likely)'],
  });
  assert.deepEqual(s.summary({ query: 'Rome' }).facts.slice(0, 2), ['- Newest likely fact about Rome (likely)', '- Sure fact']);
  await s.writeFile('persona', 'P'.repeat(4000));
  await s.writeFile('aboutYou', 'Du 😀 builds things');
  const full = s.summary();
  assert.equal(full.aboutYou, 'Du 😀 builds things');
  assert.ok(full.persona.endsWith('…') && estimateTokens(full.persona) <= 666, 'the persona is clipped to a third');
  assert.equal(full.facts.length, 3);
  // the whole summary stays within the budget, in tokens, whatever the script
  const cost = (x: any) =>
    estimateTokens(x.persona) + estimateTokens(x.aboutYou) + x.facts.reduce((n: number, l: string) => n + estimateTokens(l) + 1, 0);
  await s.writeFile('aboutYou', '我住在柏林，喜欢喝茶。'.repeat(200));
  for (const budget of [0, 5, 30, 61, 300, 2000, Number.NaN])
    assert.ok(cost(s.summary({ budgetTokens: budget })) <= (budget || 0), `${budget}`);
  assert.ok(estimateTokens(s.summary().aboutYou) <= 666, 'CJK counted a token a character');
  // the clip never cuts an emoji in half, and gives nothing when not even the ellipsis fits
  assert.ok(!/[\uD800-\uDBFF]…/.test(clipTokens('😀'.repeat(40), 5)));
  assert.equal(clipTokens('abcdefgh', 1), '');
  assert.equal(clipTokens('abcd', 1), 'abcd');
  assert.equal(estimateTokens('喝茶 tea'), 3);
});
