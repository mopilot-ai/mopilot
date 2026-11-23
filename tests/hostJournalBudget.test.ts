// Session storage must bound resident history and the shared physical budget without silently deleting other chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-budget-'));
function write(j: any, chatId: string, text: string) {
  const rev = j.head(chatId).rev;
  j.durable(chatId, { seq: j.next(chatId), rev: rev + 1, item: { text } });
}

test('independent chats share one physical disk budget and a refusal preserves both histories', () => {
  const dataDir = tmp();
  const j = createSessionJournal({ dataDir, maxTotalBytes: 3500, maxBytes: 20000 } as any);
  write(j, 'a', 'a'.repeat(800));
  write(j, 'b', 'b'.repeat(800));
  assert.throws(
    () => write(j, 'b', 'large'.repeat(1000)),
    (e: any) => e.code === 'session_journal_budget',
  );
  assert.equal(j.read('a').rev, 1);
  assert.equal(j.read('b').rev, 1);
});

test('LRU cache eviction does not change generation or reuse an allocated sequence when an inactive chat is reopened', () => {
  const dataDir = tmp();
  let reads = 0;
  const io = {
    ...fs,
    readFileSync: (...args: any[]) => {
      reads++;
      return (fs.readFileSync as any)(...args);
    },
  } as typeof fs;
  const j = createSessionJournal({ dataDir, io, maxCachedChats: 2 } as any);
  write(j, 'a', 'kept');
  const before = j.read('a');
  write(j, 'b', 'b');
  write(j, 'c', 'c');
  const count = reads;
  const after = j.read('a');
  assert.ok(reads > count, 'the inactive chat should have been evicted and reread');
  assert.equal(after.generation, before.generation);
  assert.equal(after.rev, before.rev);
  assert.ok(j.next('a') > before.seq);
});

test('the next write collects only retired journal directories after a crash, accounting their bytes against the reclaimed budget', () => {
  const dataDir = tmp();
  const seed = createSessionJournal({ dataDir });
  write(seed, 'a', 'gone'.repeat(100));
  const root = path.join(dataDir, 'sessions');
  const original = fs.readdirSync(root)[0];
  const retired = `${original}.removed.00000000-0000-0000-0000-000000000000`;
  fs.renameSync(path.join(root, original), path.join(root, retired));
  fs.mkdirSync(path.join(root, 'unrelated.removed.files'));
  const j = createSessionJournal({ dataDir, maxTotalBytes: 2000 } as any);
  j.read('b');
  assert.ok(fs.existsSync(path.join(root, retired)), 'read-only access must not mutate disk');
  write(j, 'b', 'kept');
  assert.ok(!fs.existsSync(path.join(root, retired)));
  assert.ok(fs.existsSync(path.join(root, 'unrelated.removed.files')));
});

test('unwritten generations and failed readable projections are not evicted merely to open another chat', () => {
  const dataDir = tmp();
  const j = createSessionJournal({ dataDir, maxCachedChats: 1 } as any);
  const generation = j.read('a').generation;
  assert.throws(
    () => j.read('b'),
    (e: any) => e.code === 'session_journal_busy',
  );
  assert.equal(j.read('a').generation, generation);
  j.remove('a');
  assert.equal(j.read('b').rev, 0);
});

test('active projections stay pinned, and closing one allows safe eviction under the loaded-chat limit', () => {
  const active = new Set(['a', 'b']);
  const j = createSessionJournal({ dataDir: tmp(), maxCachedChats: 2, active: (id: string) => active.has(id) });
  write(j, 'a', 'a');
  write(j, 'b', 'b');
  assert.throws(() => j.read('c'), { code: 'session_journal_busy' });
  const before = j.read('a');
  active.delete('a');
  write(j, 'c', 'c');
  assert.equal(j.read('a').generation, before.generation);
});

test('preflight accounts for the known incoming message in the cross-chat budget before dispatch', () => {
  const j = createSessionJournal({ dataDir: tmp(), maxTotalBytes: 2000 });
  write(j, 'a', 'a');
  assert.throws(() => j.check('b', 3000), { code: 'session_journal_budget' });
  assert.equal(j.read('a').rev, 1);
});

test('budget scan and retired-directory collection failures fail closed and reconcile after repair', async () => {
  const { createSessionBudget } = await import('../host/src/sessionBudget.mjs');
  for (const failAt of [1, 2]) {
    let calls = 0;
    let broken = true;
    const io = {
      ...fs,
      readdirSync: () => {
        if (++calls === failAt && broken) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return [];
      },
    } as any;
    const budget = createSessionBudget({ root: '/not-accessed', io, maxBytes: 10, full: () => new Error('full') });
    assert.throws(() => budget.check(1), /permission denied/);
    broken = false;
    budget.check(1);
  }
});
