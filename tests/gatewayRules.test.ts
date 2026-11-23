// The gateway's rules store (electron/gateway/rules.cjs, #2999 C3): none until the user adds one; a rule is written whole and durably and read again when another MoPilot changed the file; two writers before either settles keep both rules (W1); a file that can't be parsed keeps the rules last read and says so, refuses changes rather than write over it, and reset keeps it aside (W3); an entry this build can't read is counted and kept in the file as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gatewayDir } from './support/gatewayWorld.ts';

const require = createRequire(import.meta.url);
const { RulesStore, RulesUnreadableError, savedRuleOf } = require('../electron/gateway/rules.cjs');

const store = (dir = gatewayDir()) => new RulesStore({ file: path.join(dir, 'rules.json'), now: () => 7 });
const rule = (stance = 'block', pattern = '*') => ({ connector: 'k', pattern, stance, scope: 'all' });

test('none by default; add gives each rule an id and time, remove takes it out, a removed id again is no error', async () => {
  const s = store();
  assert.deepEqual(s.view(), { rules: [], state: 'ok', invalid: 0 });
  const a = await s.add(rule('block'));
  const b = await s.add(rule('allow', 'list_*'));
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.createdAt, 7);
  assert.deepEqual(
    s.view().rules.map((r: any) => [r.stance, r.pattern]),
    [
      ['block', '*'],
      ['allow', 'list_*'],
    ],
  );
  await s.remove(a.id);
  await s.remove(a.id);
  assert.deepEqual(
    s.view().rules.map((r: any) => r.id),
    [b.id],
  );
  await assert.rejects(s.add({ stance: 'block' }), /Not a rule/);
  // the file is plain JSON a person can read
  const file = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(file.v, 1);
  assert.equal(file.rules.length, 1);
});

test('W1: two stores on one file (two MoPilots), each adding before either settles, keep both; each reads the other’s', async () => {
  const dir = gatewayDir();
  const one = store(dir);
  const two = store(dir);
  await Promise.all([one.add(rule('block', 'a')), two.add(rule('allow', 'b')), one.add(rule('ask', 'c'))]);
  for (const s of [one, two])
    assert.deepEqual(
      s
        .view()
        .rules.map((r: any) => r.pattern)
        .sort(),
      ['a', 'b', 'c'],
    );
  // a removal and an add at once
  const [first] = one.view().rules;
  await Promise.all([two.remove(first.id), one.add(rule('block', 'd'))]);
  assert.deepEqual(
    one
      .view()
      .rules.map((r: any) => r.pattern)
      .sort(),
    ['a', 'b', 'c', 'd'].filter((p) => p !== first.pattern),
  );
});

test('W3: a file that can’t be parsed keeps the rules last read, says so, and refuses changes rather than write over it', async () => {
  const s = store();
  await s.add(rule('block', 'danger_*'));
  fs.writeFileSync(s.file, '{ "v": 1, "rules": [ torn');
  const v = s.view();
  assert.equal(v.state, 'unreadable');
  assert.deepEqual(
    v.rules.map((r: any) => r.pattern),
    ['danger_*'],
    'the block last read still holds',
  );
  await assert.rejects(s.add(rule('allow')), RulesUnreadableError);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ "v": 1, "rules": [ torn', 'the file is left as it was');
  // reset keeps the damaged file aside and starts again
  await s.reset();
  assert.deepEqual(s.view(), { rules: [], state: 'ok', invalid: 0 });
  const aside = fs.readdirSync(path.dirname(s.file)).filter((f) => f.startsWith('rules.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(s.file), aside[0]), 'utf8'), '{ "v": 1, "rules": [ torn');
  await s.add(rule('ask'));
  assert.equal(s.view().rules.length, 1);
  // a readable file is only emptied, nothing kept aside
  await s.reset();
  assert.equal(fs.readdirSync(path.dirname(s.file)).filter((f) => f.startsWith('rules.json.unreadable-')).length, 1);
  assert.deepEqual(s.view().rules, []);
});

test('W3: unreadable from the start (no rules ever read), or a file that is not a rules file, reads as unreadable, never as no rules', () => {
  for (const text of ['not json', '{"v":2,"rules":[]}', '{"v":1}', '[]']) {
    const s = store();
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, text);
    assert.deepEqual(s.view(), { rules: [], state: 'unreadable', invalid: 0 }, text);
  }
  // a file that can't even be looked at
  const s = store();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.mkdirSync(s.file);
  fs.writeFileSync(path.join(s.file, 'x'), '');
  const stat = fs.statSync;
  (fs as any).statSync = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  try {
    assert.equal(s.view().state, 'unreadable');
  } finally {
    (fs as any).statSync = stat;
  }
});

test('an entry this build can’t read is counted, skipped by the decider and kept in the file as it is on the next write', async () => {
  const s = store();
  await s.add(rule('allow'));
  const file = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  const future = { id: 'future-1', createdAt: 1, connector: 'k', pattern: '*', stance: 'quarantine', scope: 'all' };
  file.rules.push(future, { id: 'NOT VALID', createdAt: 1, ...rule() }, { ...rule(), id: 'no-time' });
  fs.writeFileSync(s.file, JSON.stringify(file));
  const v = s.view();
  assert.equal(v.invalid, 3);
  assert.equal(v.rules.length, 1);
  await s.add(rule('block', 'x'));
  const after = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.deepEqual(after.rules[1], future);
  assert.equal(after.rules.length, 5);
  assert.equal(savedRuleOf(null), null);
});

test('the file deleted (by hand, another MoPilot’s reset) reads as no rules', async () => {
  const s = store();
  await s.add(rule('block'));
  fs.rmSync(s.file);
  assert.deepEqual(s.view(), { rules: [], state: 'ok', invalid: 0 });
});

test('a rule the same as one saved adds nothing (two at once keep one); an unreadable file isn’t parsed again until it changes; old set-aside copies go', async () => {
  const s = store();
  const [a, b] = await Promise.all([s.add(rule('allow', 'x')), s.add(rule('allow', 'x'))]);
  assert.equal(a.id, b.id);
  assert.equal(s.view().rules.length, 1);
  assert.equal((await s.add({ ...rule('allow', 'x'), harness: 'codex' })).harness, 'codex', 'a harness makes it another rule');
  assert.equal(s.view().rules.length, 2);
  fs.writeFileSync(s.file, 'torn');
  const read = fs.readFileSync;
  let reads = 0;
  (fs as any).readFileSync = (...a: any[]) => (reads++, (read as any)(...a));
  try {
    for (let i = 0; i < 5; i++) assert.equal(s.view().state, 'unreadable');
  } finally {
    (fs as any).readFileSync = read;
  }
  assert.equal(reads, 1, 'parsed once while it stays the same');
  // a copy set aside long ago goes at the next reset; a recent one stays
  const dir = path.dirname(s.file);
  fs.writeFileSync(path.join(dir, `rules.json.unreadable-1-abcdef12`), 'old');
  const later = new RulesStore({ file: s.file, now: () => 40 * 86_400_000 });
  await later.reset();
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('rules.json.unreadable-'));
  assert.deepEqual(aside.length, 1);
  assert.ok(!aside.includes('rules.json.unreadable-1-abcdef12'));
});
