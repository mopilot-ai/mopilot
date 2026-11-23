// MoMo memory's change log, background-pass rules and undo (#2139 P3, electron/momo/memoryLog.cjs and electron/momo/memory.cjs): every change logged with its author and before/after, a pass that never touches what the user wrote and changes at most a fifth of the facts, a replaced fact kept as past, undo that refuses to overwrite a later change, and older facts fading in ranking instead of a hard cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sealed, src, momoStore as store } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const { MemoryError, MAX_FACTS, FACTS_FILE } = require('../electron/momo/memory.cjs');
const { CHANGES_FILE, MAX_CHANGES, MAX_PASS_ADDS, isChange, sameFact, applyPass, undoChange } = require('../electron/momo/memoryLog.cjs');
const { isFact, strength, rankFacts, HALF_LIFE_DAYS } = require('../electron/momo/memoryFacts.cjs');

const DAY = 24 * 60 * 60 * 1000;
const texts = (facts: any[]) => facts.map((f) => f.text);

test('saves, edits and forgets are logged newest first with who made them and each fact before and after', async () => {
  const { s, tick } = store();
  const { fact } = await s.save({ text: 'Lives in Berlin', source: src });
  tick();
  await s.save({ text: 'lives in berlin', source: src });
  await s.update(fact.id, { text: 'Lives in Munich' });
  tick();
  await s.forget(fact.id, { by: src });
  const log = s.changes();
  assert.deepEqual(
    log.map((c: any) => [c.op, c.by]),
    [
      ['forget', src],
      ['update', 'user'],
      ['save', src],
    ],
    'the duplicate save changed nothing and logged nothing',
  );
  assert.equal(log[2].items[0].before, null);
  assert.equal(log[2].items[0].after.text, 'Lives in Berlin');
  assert.deepEqual([log[1].items[0].before.text, log[1].items[0].after.text], ['Lives in Berlin', 'Lives in Munich']);
  assert.equal(log[0].items[0].after, null);
  for (const c of log) {
    assert.ok(isChange(c), JSON.stringify(c));
    assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'own ids (UUIDs), never a fact id');
  }
  // the log is sealed like the facts: no plain text on disk
  assert.ok(!fs.readFileSync(path.join(s.dir, CHANGES_FILE), 'utf8').includes('Berlin'));
});

test('a pass adds MoMo-inferred facts, updates and supersedes its own, and keeps the replaced fact as past', async () => {
  const { s, tick } = store();
  for (const t of ['Has a dog', 'Works at Acme', 'Plays tennis', 'Reads sci-fi', 'Likes jazz']) await s.save({ text: t, source: src });
  tick(10);
  const { change, skipped } = await s.applyPass(
    [
      { op: 'add', text: 'Moved to Lisbon in 2026', confidence: 'sure' },
      { op: 'noop' },
      { op: 'supersede', id: 'f2', text: 'Works at Globex' },
    ],
    { source: src, reason: 'chat idle' },
  );
  assert.deepEqual(skipped, []);
  assert.equal(change.by, 'pass');
  assert.equal(change.reason, 'chat idle');
  const added = s.list().facts.find((f: any) => f.text === 'Moved to Lisbon in 2026');
  assert.equal(added.origin, 'extracted', 'marked as inferred by MoMo');
  assert.equal(added.confidence, 'sure');
  assert.ok(!texts(s.list().facts).includes('Works at Acme'), 'the replaced fact is no longer in use');
  assert.ok(texts(s.list().facts).includes('Works at Globex'));
  const past = s.list({ includePast: true }).facts.find((f: any) => f.text === 'Works at Acme');
  assert.equal(past.invalidAt, 1010);
  assert.equal(past.supersededBy, s.list().facts.find((f: any) => f.text === 'Works at Globex').id);
  assert.ok(!texts(s.search('Acme')).length, 'search leaves past facts out');
  assert.ok(!s.summary().facts.some((l: string) => l.includes('Acme')), 'and so does the summary');
  // an update keeps the fact and its id
  tick();
  const up = await s.applyPass([{ op: 'update', id: added.id, confidence: 'likely' }], { source: src });
  assert.equal(up.change.items[0].after.confidence, 'likely');
  assert.equal(up.change.items[0].after.id, added.id);
});

test("a pass never touches the user's facts, skips duplicates and unknown ops, and changes at most a fifth of the facts", async () => {
  const { s } = store();
  await s.save({ text: 'My name is Du', source: 'user' });
  for (let i = 0; i < 9; i++) await s.save({ text: `fact ${i}`, source: src });
  // 10 in use: a budget of 2 changes to existing facts
  const { change, skipped } = await s.applyPass(
    [
      { op: 'update', id: 'f1', text: 'My name is Bob' },
      { op: 'add', text: 'fact 3' },
      { op: 'update', id: 'nope', text: 'x' },
      { op: 'update', id: 'f2', text: 'fact 4' },
      { op: 'delete', id: 'f2' },
      { op: 'update', id: 'f2', text: 'fact zero, edited' },
      { op: 'supersede', id: 'f3', text: 'fact one, replaced' },
      { op: 'update', id: 'f4', text: 'fact two, edited' },
    ],
    { source: src },
  );
  assert.deepEqual(
    skipped.map((x: any) => x.reason),
    ['written by the user', 'duplicate', 'no such fact', 'duplicate', 'unknown op', 'over the change limit'],
  );
  assert.equal(change.items.length, 3, 'one update, one supersede (old and new)');
  assert.equal(s.list().facts.find((f: any) => f.id === 'f1').text, 'My name is Du');
  // a replaced fact is not in use any more: a second pass can't change it
  const again = await s.applyPass([{ op: 'update', id: 'f3', text: 'again' }], { source: src });
  assert.deepEqual(again.skipped, [{ op: 'update', id: 'f3', reason: 'not in use' }]);
  assert.equal(again.change, null, 'a pass that changed nothing logs nothing');
});

test('a pass adds at most MAX_PASS_ADDS facts, reads only a MoMo chat, and is refused past the storage guard', async () => {
  const { s, safe } = store();
  const many = Array.from({ length: MAX_PASS_ADDS + 2 }, (_, i) => ({ op: 'add', text: `new ${i}` }));
  const { skipped } = await s.applyPass(many, { source: src });
  assert.deepEqual(
    skipped.map((x: any) => x.reason),
    ['too many adds', 'too many adds'],
  );
  await assert.rejects(s.applyPass([{ op: 'add', text: 'x' }], { source: 'user' }), /never the user/);
  await assert.rejects(s.applyPass([{ op: 'add', text: 'x' }], { source: { chatId: 'coding', harness: 'codex' } }), MemoryError);
  await assert.rejects(s.applyPass([{ op: 'add', text: '' }], { source: src }), MemoryError);
  assert.deepEqual((await s.applyPass('nonsense' as any, { source: src })).skipped, []);
  // a full memory refuses the whole pass, and the file stays as it was
  const file = path.join(s.dir, FACTS_FILE);
  const lines = Array.from({ length: MAX_FACTS }, (_, i) =>
    sealed(safe, JSON.stringify({ id: `x${i}`, text: `kept ${i}`, source: src, createdAt: 1, confidence: 'likely' })),
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  await assert.rejects(s.applyPass([{ op: 'add', text: 'one more' }], { source: src }), (e: any) => e.code === 'full');
  assert.equal(s.list().facts.length, MAX_FACTS);
});

test('undo puts back every fact a change touched, logs the undo, and refuses a second undo or an undo of an undo', async () => {
  const { s, tick } = store();
  await s.save({ text: 'Has a dog', source: src });
  await s.save({ text: 'Works at Acme', source: src });
  tick();
  const { change } = await s.applyPass(
    [
      { op: 'supersede', id: 'f2', text: 'Works at Globex' },
      { op: 'add', text: 'Likes jazz' },
    ],
    { source: src },
  );
  tick();
  const undo = await s.undo(change.id);
  assert.equal(undo.op, 'undo');
  assert.equal(undo.by, 'user');
  assert.deepEqual(texts(s.list({ includePast: true }).facts).sort(), ['Has a dog', 'Works at Acme']);
  assert.equal(s.list().facts.find((f: any) => f.text === 'Works at Acme').invalidAt, undefined, 'back in use');
  assert.equal(s.changes().find((c: any) => c.id === change.id).undone, 1002);
  await assert.rejects(s.undo(change.id), (e: any) => e.code === 'changed' && /undone already/.test(e.message));
  await assert.rejects(s.undo(undo.id), (e: any) => e.code === 'changed' && /cannot be undone/.test(e.message));
  await assert.rejects(s.undo('missing'), (e: any) => e.code === 'changed' && /no longer in the log/.test(e.message));
});

test('undo restores a forgotten fact and an edit, and refuses when the fact changed again since', async () => {
  const { s } = store();
  const { fact } = await s.save({ text: 'Lives in Berlin', source: src });
  await s.forget(fact.id);
  await s.undo(s.changes()[0].id);
  assert.deepEqual(texts(s.list().facts), ['Lives in Berlin']);
  await s.update(fact.id, { text: 'Lives in Munich' });
  const edit = s.changes()[0];
  await s.update(fact.id, { text: 'Lives in Paris' });
  await assert.rejects(s.undo(edit.id), (e: any) => e.code === 'changed' && /changed since/.test(e.message));
  assert.deepEqual(texts(s.list().facts), ['Lives in Paris'], 'the later change stays');
  await s.undo(s.changes()[0].id);
  await s.undo(edit.id);
  assert.deepEqual(texts(s.list().facts), ['Lives in Berlin'], 'newest first, then the older one');
});

test('a fact saved again after it was replaced comes back in use; an undo of that save puts the past fact back', async () => {
  const { s } = store();
  await s.save({ text: 'Works at Acme', source: src });
  await s.applyPass([{ op: 'supersede', id: 'f1', text: 'Works at Globex' }], { source: src });
  const again = await s.save({ text: 'works at acme', source: src });
  assert.equal(again.saved, true);
  assert.equal(again.fact.invalidAt, undefined);
  assert.ok(texts(s.list().facts).includes('works at acme'));
  await s.undo(s.changes()[0].id);
  assert.ok(s.list({ includePast: true }).facts.find((f: any) => f.text === 'Works at Acme').invalidAt);
});

test('the log keeps the newest MAX_CHANGES and skips a line it cannot read', async () => {
  const { s, safe } = store();
  await s.save({ text: 'first', source: src });
  const file = path.join(s.dir, CHANGES_FILE);
  fs.appendFileSync(file, 'not sealed\n' + sealed(safe, '{"id":"x"}') + '\n' + sealed(safe, 'not json') + '\n');
  assert.equal(s.changes().length, 1, 'a line that is not a change, or not even JSON, is skipped');
  for (let i = 0; i < MAX_CHANGES + 3; i++) await s.update('f1', { text: `edit ${i}` });
  const log = s.changes();
  assert.equal(log.length, MAX_CHANGES);
  assert.equal(log[0].items[0].after.text, `edit ${MAX_CHANGES + 2}`);
  assert.ok(!log.some((c: any) => c.op === 'save'), 'the oldest went');
});

test('the pure rules: sameFact ignores field order, undo of an emptied log entry and a moved fact', () => {
  const a = { id: 'a', text: 't', source: src, createdAt: 1, confidence: 'sure' };
  assert.ok(sameFact(a, { confidence: 'sure', createdAt: 1, source: src, text: 't', id: 'a' }));
  assert.ok(!sameFact(a, null));
  assert.ok(sameFact(null, null));
  assert.ok(!sameFact(a, { ...a, invalidAt: 2 }));
  // a forgotten fact whose line is gone comes back at the end
  const back = undoChange([], { id: 'c', at: 1, by: 'user', op: 'forget', items: [{ before: a, after: null }] });
  assert.deepEqual(back.lines, [{ fact: a }]);
  assert.deepEqual(back.items, [{ before: null, after: a }]);
  assert.throws(() => applyPass([], [], { source: 'user', isMomoChat: () => true, now: 1, newId: () => 'n' }), /never the user/);
});

test('isChange and isFact accept the new fields and refuse malformed ones', () => {
  const fact = { id: 'a', text: 't', source: src, createdAt: 1, confidence: 'sure' };
  assert.ok(isFact({ ...fact, origin: 'extracted', invalidAt: 5, supersededBy: 'b' }));
  for (const bad of [{ origin: 'model' }, { invalidAt: 'soon' }, { supersededBy: '' }, { supersededBy: 3 }])
    assert.ok(!isFact({ ...fact, ...bad }));
  const change = { id: 'c', at: 1, by: 'pass', op: 'pass', items: [{ before: null, after: fact }] };
  assert.ok(isChange(change));
  assert.ok(isChange({ ...change, by: src, undone: 3, reason: 'r' }));
  for (const bad of [
    null,
    { ...change, id: '' },
    { ...change, at: 'x' },
    { ...change, by: 'someone' },
    { ...change, op: 'delete' },
    { ...change, items: 'x' },
    { ...change, items: [null] },
    { ...change, items: [{ before: { id: 1 }, after: null }] },
    { ...change, undone: 'x' },
    { ...change, reason: 4 },
  ])
    assert.ok(!isChange(bad), JSON.stringify(bad));
});

test('older facts fade: strength halves every HALF_LIFE_DAYS, sure outweighs likely, and a tie in strength falls back to the newer', () => {
  const now = 1000 * DAY;
  const f = (createdAt: number, confidence = 'likely', id = 'x') => ({ id, text: 'coffee', source: src, createdAt, confidence });
  assert.equal(strength(f(now, 'sure'), now), 1);
  assert.equal(strength(f(now), now), 0.7);
  assert.ok(Math.abs(strength(f(now - HALF_LIFE_DAYS * DAY, 'sure'), now) - 0.5) < 1e-9);
  assert.equal(strength(f(now + DAY, 'sure'), now), 1, 'a clock skew never makes a fact stronger than new');
  // an old sure fact gives way to a new likely one
  assert.deepEqual(
    rankFacts([f(now - 2 * HALF_LIFE_DAYS * DAY, 'sure', 'old'), f(now, 'likely', 'new')], 'coffee', 10, now).map((x: any) => x.id),
    ['new', 'old'],
  );
  assert.deepEqual(
    rankFacts([f(5, 'sure', 'a'), f(5, 'sure', 'b')], 'coffee', 10, now).map((x: any) => x.id),
    ['a', 'b'],
    'equal strength and time: the order given',
  );
});

test('a pass, an edit and an undo started at once run in order: the undo sees the edit and refuses to overwrite it', async () => {
  const { s } = store();
  await s.save({ text: 'Works at Acme', source: src });
  await s.save({ text: 'Has a dog', source: src });
  const dogSave = s.changes()[0];
  const [pass, edit, undo] = await Promise.allSettled([
    s.applyPass([{ op: 'supersede', id: 'f1', text: 'Works at Globex' }], { source: src }),
    s.update('f2', { text: 'Has two dogs' }),
    s.undo(dogSave.id),
  ]);
  assert.equal(pass.status === 'fulfilled' && pass.value.change.op, 'pass');
  assert.equal(edit.status === 'fulfilled' && edit.value.text, 'Has two dogs');
  assert.equal(undo.status === 'rejected' && undo.reason.code, 'changed');
  assert.deepEqual(texts(s.list().facts).sort(), ['Has two dogs', 'Works at Globex']);
  assert.deepEqual(
    s.changes().map((c: any) => c.op),
    ['update', 'pass', 'save', 'save'],
    'the refused undo logged nothing',
  );
});
