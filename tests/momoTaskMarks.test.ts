// What the user marks on a MoMo task (electron/momo/taskMarks.cjs over its storage seam; the sealed file is wired in app/momoTaskMarks.cjs): done, archive, delete and reopen on a routine run, keyed by its stable id; entries last 30 days and at most 500; an Undo token (60 s) puts back what a mark replaced and nothing else; only a run can be marked; and a sealed file keeps the marks across a restart and goes with Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const {
  createTaskMarks,
  marksShape,
  memoryStorage,
  MarkError,
  KEEP_MS,
  MAX_MARKS,
  UNDO_MS,
  MAX_UNDO,
} = require('../electron/momo/taskMarks.cjs');
const { openTaskMarks, FILE } = require('../electron/app/momoTaskMarks.cjs');

const NOW = Date.UTC(2026, 10, 15, 12);
function rig(start = NOW) {
  const clock = { at: start };
  let n = 0;
  const now = () => clock.at;
  const marks = createTaskMarks({ storage: memoryStorage({ now }), now, newToken: () => `t${++n}` });
  return { marks, clock };
}
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: any) => e instanceof MarkError && e.code === c);

test('a run is marked done, archived or deleted from view, and reopened: each is what the user asked and nothing else', async () => {
  const { marks, clock } = rig();
  assert.deepEqual(marks.list(), {});
  const done = await marks.mark('run:c1', 'done');
  assert.deepEqual([done.taskId, done.mark, typeof done.undoToken], ['run:c1', 'done', 'string']);
  assert.deepEqual(marks.list(), { 'run:c1': { mark: 'done', at: NOW } });
  clock.at += 1000;
  assert.equal((await marks.mark('run:c1', 'archive')).mark, 'archived');
  assert.equal((await marks.mark('run:c1', 'delete')).mark, 'deleted');
  assert.equal(marks.list()['run:c1'].mark, 'deleted');
  assert.deepEqual(await marks.mark('run:c1', 'reopen').then((r: any) => [r.mark, r.undoToken !== undefined]), [null, true]);
  assert.deepEqual(marks.list(), {});
});

test('marking what is marked the same way, or reopening what is open, changes nothing and offers no Undo', async () => {
  const { marks } = rig();
  assert.deepEqual(await marks.mark('run:c1', 'reopen'), { taskId: 'run:c1', mark: null });
  await marks.mark('run:c1', 'done');
  assert.deepEqual(await marks.mark('run:c1', 'done'), { taskId: 'run:c1', mark: 'done' });
});

test('only a routine run can be marked, with a request the panel knows', async () => {
  const { marks } = rig();
  for (const id of ['loop:L1', 'card:a1', 'routine:r1', 'run:', 7, null, `run:${'x'.repeat(200)}`])
    await code(marks.mark(id, 'done'), 'bad_args');
  for (const what of ['finish', undefined, 3, '__proto__', 'toString']) await code(marks.mark('run:c1', what), 'bad_args');
  assert.deepEqual(marks.list(), {});
});

test('Undo takes back exactly one mark, once, while the mark is still the latest', async () => {
  const { marks } = rig();
  const first = await marks.mark('run:c1', 'archive');
  assert.equal((await marks.mark('run:c1', 'reopen', first.undoToken)).mark, null);
  assert.deepEqual(marks.list(), {});
  // the token is spent
  await code(marks.mark('run:c1', 'reopen', first.undoToken), 'expired');
  // undoing a change over an earlier mark puts the earlier one back
  await marks.mark('run:c2', 'done');
  const over = await marks.mark('run:c2', 'archive');
  assert.equal((await marks.mark('run:c2', 'reopen', over.undoToken)).mark, 'done');
  // undoing a reopen puts the mark back
  const reopened = await marks.mark('run:c2', 'reopen');
  assert.equal((await marks.mark('run:c2', 'done', reopened.undoToken)).mark, 'done');
  assert.equal(marks.list()['run:c2'].mark, 'done');
});

test('Undo refuses a token for another task, an unknown one, one past its minute, and a mark changed since', async () => {
  const { marks, clock } = rig();
  const a = await marks.mark('run:c1', 'done');
  await code(marks.mark('run:c2', 'reopen', a.undoToken), 'expired');
  await code(marks.mark('run:c1', 'reopen', 'nope'), 'expired');
  await code(marks.mark('run:c1', 'reopen', 42), 'expired');
  // changed since: archived after done, so the done token can no longer undo
  const later = await marks.mark('run:c3', 'done');
  clock.at += 5;
  await marks.mark('run:c3', 'archive');
  await code(marks.mark('run:c3', 'reopen', later.undoToken), 'expired');
  assert.equal(marks.list()['run:c3'].mark, 'archived');
  // the same mark made again later (a new time) is a different mark: the old token does not take it back
  const old = await marks.mark('run:c4', 'done');
  await marks.mark('run:c4', 'reopen');
  clock.at += 5;
  await marks.mark('run:c4', 'done');
  await code(marks.mark('run:c4', 'reopen', old.undoToken), 'expired');
  // a minute later nothing can be undone
  const b = await marks.mark('run:c5', 'done');
  clock.at += UNDO_MS;
  await code(marks.mark('run:c5', 'reopen', b.undoToken), 'expired');
  assert.equal(marks.list()['run:c5'].mark, 'done');
});

test('no more than MAX_UNDO tokens are kept: the oldest goes first', async () => {
  const { marks } = rig();
  const first = await marks.mark('run:c0', 'done');
  for (let i = 1; i <= MAX_UNDO; i++) await marks.mark(`run:c${i}`, 'done');
  // the next call drops the oldest token before it checks
  await code(marks.mark('run:c0', 'reopen', first.undoToken), 'expired');
});

test('marks are kept 30 days, the newest 500, and what is not a mark is dropped', async () => {
  const { marks, clock } = rig();
  await marks.mark('run:old', 'done');
  clock.at += KEEP_MS - 1;
  assert.deepEqual(Object.keys(marks.list()), ['run:old']);
  clock.at += 1;
  assert.deepEqual(marks.list(), {});
  const many = Object.fromEntries(Array.from({ length: MAX_MARKS + 5 }, (_, i) => [`run:c${i}`, { mark: 'done', at: NOW + i }]));
  const kept = marksShape(
    { marks: { ...many, 'loop:x': { mark: 'done', at: NOW }, 'run:bad': { mark: 'nope', at: NOW }, 'run:nan': { mark: 'done', at: 'x' } } },
    NOW + 1000,
  );
  assert.equal(Object.keys(kept.marks).length, MAX_MARKS);
  assert.equal(kept.marks['run:c0'], undefined, 'the oldest went');
  assert.ok(kept.marks[`run:c${MAX_MARKS + 4}`]);
  for (const junk of [null, undefined, 'x', { marks: null }, { marks: [] }, { marks: 'x' }])
    assert.deepEqual(marksShape(junk, NOW), { marks: {} });
});

test('the storage is read and written through the seam alone: a failing write keeps nothing and says so', async () => {
  const calls: string[] = [];
  const storage = {
    read: () => (calls.push('read'), { marks: {} }),
    change: async (fn: any) => (calls.push('change'), fn({ marks: {} })),
  };
  const marks = createTaskMarks({ storage, now: () => NOW });
  assert.deepEqual(marks.list(), {});
  await marks.mark('run:c1', 'done');
  assert.deepEqual(calls, ['read', 'change']);
  const broken = createTaskMarks({
    storage: {
      read: () => ({ marks: {} }),
      change: async () => {
        throw new Error('disk full');
      },
    },
  });
  await assert.rejects(broken.mark('run:c1', 'done'), /disk full/);
});

test('the default clock and token work without being given', async () => {
  const marks = createTaskMarks({ storage: memoryStorage() });
  const r = await marks.mark('run:c1', 'done');
  assert.match(r.undoToken, /^[0-9a-f-]{36}$/);
  assert.equal(marks.list()['run:c1'].mark, 'done');
});

test('the sealed file keeps the marks across a restart, is private, and Reset erases it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmarks-'));
  const safe = fakeSafe();
  try {
    const a = openTaskMarks({ dir, safeStorage: safe, now: () => NOW });
    await a.marks.mark('run:c1', 'archive');
    const file = path.join(dir, FILE);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    // sealed: the id and the mark are not in the file as text
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /run:c1|archived/);
    const b = openTaskMarks({ dir, safeStorage: safe, now: () => NOW });
    assert.deepEqual(b.marks.list(), { 'run:c1': { mark: 'archived', at: NOW } });
    await b.erase();
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(openTaskMarks({ dir, safeStorage: safe }).marks.list(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
