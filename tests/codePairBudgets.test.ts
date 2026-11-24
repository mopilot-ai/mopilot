// The Host's one durable run budget per code offer (host/src/codePairBudgets.mjs, R2b of #5576): the count and the spent code survive a restart, an id is never given a second budget, only the relay's own form of id is used, a write that fails starts no run, and a file that cannot be read starts the store empty with every id burned for ten minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createCodePairBudgets, KEEP_MS } from '../host/src/codePairBudgets.mjs';

const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
/** An offer id in the relay's form. */
const id = (n: string) => `r_${n.padEnd(22, 'x')}`;

test('an offer has one budget, and its count and its spent code come back after a restart', (t) => {
  const file = path.join(dirOf(t), 'code-pair.json');
  let clock = 1000;
  const first = createCodePairBudgets({ file, now: () => clock });
  const budget = first.forOffer(id('a'));
  assert.equal(first.forOffer(id('a')), budget, 'a second budget for the same offer is a second chance the code does not have');
  assert.equal(budget.begin(), true);
  assert.equal(budget.begin(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // a restart in the middle: two runs counted, one left
  const second = createCodePairBudgets({ file, now: () => clock });
  const back = second.forOffer(id('a'));
  assert.equal(back.left, 1);
  assert.equal(back.begin(), true);
  assert.equal(back.begin(), false, 'the third start burned it');
  assert.equal(second.burned(id('a')), true);
  // another offer is untouched; a spent one stays spent
  const other = second.forOffer(id('b'));
  assert.equal(other.left, 3);
  other.begin();
  other.confirmed();
  clock += 5;
  const third = createCodePairBudgets({ file, now: () => clock });
  assert.equal(third.forOffer(id('b')).begin(), false);
  assert.equal(third.burned(id('b')), true);
  assert.equal(third.burned(id('never')), false);
  assert.equal(third.pausedUntil(), 0);
  // the secret is never written
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret/i);
});

test("only the relay's own form of id is used: a name on a prototype is never a budget, in a call or in a file", (t) => {
  const file = path.join(dirOf(t), 'code-pair.json');
  const store = createCodePairBudgets({ file });
  for (const bad of [
    '__proto__',
    'constructor',
    'toString',
    '',
    'r_short',
    `r_${'x'.repeat(23)}`,
    'x'.repeat(24),
    7,
    null,
    undefined,
    {},
  ]) {
    assert.throws(() => store.forOffer(bad as any), /not an offer id/, String(bad));
  }
  store.forOffer(id('ok')).begin();
  // a file that names such ids keeps none of them, and the rest stands
  fs.writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      offers: {
        __proto__: { started: 1, spent: true },
        constructor: { started: 0, spent: false },
        [id('ok')]: { started: 2, spent: false, at: Date.now() },
      },
    }),
  );
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"offers":{', '"offers":{"__proto__":{"started":0,"spent":false},'));
  const again = createCodePairBudgets({ file });
  assert.equal(again.size(), 1);
  assert.equal(again.forOffer(id('ok')).left, 1);
  assert.equal(({} as any).started, undefined, 'no prototype was touched');
});

test('a finished offer is forgotten after ten minutes, and a loop of offers keeps only the newest', (t) => {
  const file = path.join(dirOf(t), 'code-pair.json');
  let clock = 0;
  const store = createCodePairBudgets({ file, now: () => clock });
  store.forOffer(id('old')).begin();
  clock += KEEP_MS + 1;
  store.forOffer(id('new')).begin();
  assert.equal(createCodePairBudgets({ file, now: () => clock }).burned(id('old')), false);
  for (let i = 0; i < 80; i++) {
    clock += 1;
    store.forOffer(id(`o${i}`)).begin();
  }
  assert.ok(store.size() <= 64);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).offers[id('o79')].started, 1, 'the newest is kept');
});

test('a write that fails starts no run and counts nothing, for a start and for a first-ever offer', (t) => {
  const file = path.join(dirOf(t), 'code-pair.json');
  let failing = false;
  const store = createCodePairBudgets({
    file,
    write: (f: string, text: string) => {
      if (failing) throw new Error('disk full');
      fs.writeFileSync(f, text);
    },
  });
  const budget = store.forOffer(id('x'));
  failing = true;
  assert.throws(() => budget.begin(), /disk full/);
  assert.equal(store.size(), 0);
  failing = false;
  assert.equal(budget.left, 3, 'nothing was counted');
  assert.equal(budget.begin(), true);
  failing = true;
  assert.throws(() => budget.begin(), /disk full/);
  assert.equal(budget.left, 2, 'the earlier count stands');
});

test('a file that is not this store is set aside and every id is burned for ten minutes, across a restart; an entry of the wrong shape is a spent code', (t) => {
  const dir = dirOf(t);
  let clock = 5000;
  for (const [i, content] of ['not json', '[]', '{"v":2,"offers":{}}', '{"v":1,"offers":[]}', '{"v":1}'].entries()) {
    const file = path.join(dir, `f${i}.json`);
    fs.writeFileSync(file, content);
    const store = createCodePairBudgets({ file, now: () => clock });
    assert.equal(store.size(), 0, content);
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(`f${i}.json.corrupt-`)).length, 1, 'moved aside, not trusted');
    // it forgot which ids were used, so it believes none is new
    assert.equal(store.pausedUntil(), clock + KEEP_MS);
    assert.equal(store.forOffer(id('fresh')).begin(), false, 'an id of unknown history is burned');
    // the pause was written: a restart inside the ten minutes holds it, one after it does not
    clock += KEEP_MS - 1;
    assert.equal(
      createCodePairBudgets({ file, now: () => clock })
        .forOffer(id('other'))
        .begin(),
      false,
    );
    clock += 2;
    const later = createCodePairBudgets({ file, now: () => clock });
    assert.equal(later.pausedUntil(), 0);
    assert.equal(later.forOffer(id('after')).begin(), true);
    clock += 10;
  }
  const file = path.join(dir, 'shape.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      offers: { [id('a')]: { started: 'x', spent: false }, [id('b')]: { started: 1, spent: false, at: 5 }, [id('c')]: null },
    }),
  );
  const store = createCodePairBudgets({ file, now: () => 7 });
  assert.equal(store.forOffer(id('a')).begin(), false);
  assert.equal(store.forOffer(id('c')).begin(), false);
  assert.equal(store.forOffer(id('b')).left, 2);
  // a directory where the file should be cannot be read: the store starts empty and paused
  const odd = path.join(dir, 'odd.json');
  fs.mkdirSync(odd);
  const blocked = createCodePairBudgets({ file: odd, now: () => 9 });
  assert.equal(blocked.size(), 0);
  assert.ok(blocked.pausedUntil() > 0);
});

test('a pause whose write fails still holds in memory', (t) => {
  const file = path.join(dirOf(t), 'code-pair.json');
  fs.writeFileSync(file, 'junk');
  const store = createCodePairBudgets({
    file,
    now: () => 1,
    write: () => {
      throw new Error('read-only');
    },
  });
  assert.equal(store.pausedUntil(), 1 + KEEP_MS);
  assert.equal(store.forOffer(id('z')).begin(), false);
});

test('the default write creates the folder and leaves no temporary file', (t) => {
  const file = path.join(dirOf(t), 'deep', 'code-pair.json');
  createCodePairBudgets({ file }).forOffer(id('z')).begin();
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['code-pair.json']);
});

test('an entry with no time is kept as of now, and a file that cannot be moved aside is overwritten by the next write', (t) => {
  const dir = dirOf(t);
  const file = path.join(dir, 'no-time.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, offers: { [id('t')]: { started: 1, spent: false } } }));
  const store = createCodePairBudgets({ file, now: () => 42 });
  assert.equal(store.forOffer(id('t')).left, 2);
  store.forOffer(id('t')).begin();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).offers[id('t')].at, 42);
  // not this store, in a folder where nothing can be moved: still no memory, still paused, and the next write replaces it
  if (process.getuid?.() === 0) return;
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  const junk = path.join(locked, 'code-pair.json');
  fs.writeFileSync(junk, 'junk');
  fs.chmodSync(locked, 0o500);
  try {
    const stuck = createCodePairBudgets({ file: junk, now: () => 7 });
    assert.equal(stuck.size(), 0);
    assert.equal(stuck.pausedUntil(), 7 + KEEP_MS);
    assert.equal(fs.readFileSync(junk, 'utf8'), 'junk', 'nothing could be written either');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});
