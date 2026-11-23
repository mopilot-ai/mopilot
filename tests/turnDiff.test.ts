import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnState, ThreadItem } from '../src/store/types.ts';

const { changedFiles, changesScope, lastTurnDiffFiles, turnDiffFiles } = await import('../src/lib/turnDiff.ts');

const patch = (path: string, before = 'old', after = 'new') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const turn = (id: string, diff?: string, items: ThreadItem[] = []): TurnState => ({
  id,
  diff,
  items,
  status: 'completed',
  startedAt: null,
  completedAt: null,
  durationMs: null,
  error: null,
  itemTimes: {},
});
const edit = (path: string, diff: string, status: 'completed' | 'inProgress' | 'failed' | 'declined' = 'completed'): ThreadItem => ({
  type: 'fileChange',
  id: `${path}-${diff}`,
  status,
  changes: [{ path, kind: { type: 'update', move_path: null }, diff }],
});

test('a diff-only turn supplies files and counts without fileChange items', () => {
  const files = turnDiffFiles(turn('script', patch('a.ts') + patch('b.ts')));
  assert.deepEqual(
    files.map(({ path, added, removed }) => ({ path, added, removed })),
    [
      { path: 'a.ts', added: 1, removed: 1 },
      { path: 'b.ts', added: 1, removed: 1 },
    ],
  );
});

test('aggregate diff wins over item patches, preventing double counting', () => {
  const files = turnDiffFiles(turn('both', patch('a.ts'), [edit('/repo/a.ts', patch('/repo/a.ts'))]));
  assert.equal(files.length, 1);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
});

test('an empty aggregate diff represents no net changes, not stale item patches', () => {
  assert.deepEqual(turnDiffFiles(turn('reverted', '', [edit('a.ts', patch('a.ts'))])), []);
});

test('older item-only turns merge multiple edits to a file and omit failed edits', () => {
  const files = turnDiffFiles(
    turn('legacy', undefined, [
      edit('a.ts', '@@ -1 +1 @@\n-old\n+new\n'),
      edit('a.ts', '@@ -3,0 +4 @@\n+extra\n'),
      edit('failed.ts', patch('failed.ts'), 'failed'),
      edit('declined.ts', patch('declined.ts'), 'declined'),
    ]),
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.ts');
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);
  assert.deepEqual(
    files[0].lines.filter((line) => line.kind === 'add').map((line) => line.text),
    ['new', 'extra'],
  );
});

test('item-only turns skip changes that were recorded without a path', () => {
  const pathless = {
    type: 'fileChange',
    id: 'x',
    status: 'completed',
    changes: [
      { kind: { type: 'add' }, diff: 'lost' },
      { path: 'a.ts', kind: { type: 'add' }, diff: 'kept' },
    ],
  } as unknown as ThreadItem;
  assert.deepEqual(
    turnDiffFiles(turn('legacy', undefined, [pathless])).map((f) => f.path),
    ['a.ts'],
  );
});

test('an edit still awaiting approval is not a change until it is applied (#1939)', () => {
  const pending = turn('asking', undefined, [edit('/repo/notes.txt', patch('notes.txt'), 'inProgress')]);
  assert.deepEqual(turnDiffFiles(pending), []);
  const applied = turn('allowed', undefined, [edit('/repo/notes.txt', patch('notes.txt'))]);
  assert.deepEqual(
    turnDiffFiles(applied).map((f) => f.path),
    ['/repo/notes.txt'],
  );
});

test("item edits outside the chat's folder, like a Claude plan file, are not its changes (#1939)", () => {
  const plan = '/Users/me/Library/Application Support/MoPilot Code/claude-accounts/a1/plans/plan.md';
  const t = turn('planning', undefined, [
    edit(plan, patch('plan.md')),
    edit('/repo/src/a.ts', patch('a.ts')),
    edit('rel.ts', patch('rel.ts')),
    // relative paths that climb out of the folder are outside it too
    edit('../out.ts', patch('out.ts')),
    edit('..', patch('up')),
  ]);
  assert.deepEqual(
    turnDiffFiles(t, '/repo').map((f) => f.path),
    ['/repo/src/a.ts', 'rel.ts'],
  );
  assert.equal(turnDiffFiles(t).length, 5, 'without a folder every applied edit counts');
  assert.equal(turnDiffFiles(t, null).length, 5);
});

test('an undone turn leaves no changes; the latest turn still on disk is shown instead (#1939)', () => {
  const older = turn('older', patch('older.ts'));
  const undone = { ...turn('undone', patch('undone.ts')), undone: true };
  assert.deepEqual(changedFiles(undone), []);
  assert.equal(changedFiles({ ...undone, undone: false })[0].path, 'undone.ts');
  assert.equal(lastTurnDiffFiles([older, undone])[0].path, 'older.ts');
  assert.deepEqual(lastTurnDiffFiles([older, undone], 'undone'), []);
  assert.deepEqual(lastTurnDiffFiles([turn('t', undefined, [edit('/elsewhere/x.md', patch('x.md'))])], undefined, '/repo'), []);
});

test('newer diff-only turns are selected ahead of older fileChange turns', () => {
  const turns = [turn('old', undefined, [edit('old.ts', patch('old.ts'))]), turn('new', patch('new.ts')), turn('chat')];
  assert.equal(lastTurnDiffFiles(turns)[0].path, 'new.ts');
});

test('a pinned turn shows its own diff and never another turn', () => {
  const turns = [turn('old', patch('old.ts')), turn('new', patch('new.ts')), turn('chat')];
  assert.equal(lastTurnDiffFiles(turns, 'old')[0].path, 'old.ts');
  assert.deepEqual(lastTurnDiffFiles(turns, 'chat'), []);
  assert.deepEqual(lastTurnDiffFiles(turns, 'missing'), []);
});

test('empty histories and turns without changes have empty file lists', () => {
  assert.deepEqual(lastTurnDiffFiles([]), []);
  assert.deepEqual(lastTurnDiffFiles([turn('chat')]), []);
});

test('opening Changes without a turn uses the last picked scope, Branch until one is picked', () => {
  assert.equal(changesScope({}), 'branch');
  assert.equal(changesScope({}, { changesScope: 'uncommitted' }), 'uncommitted');
  assert.equal(changesScope({}, { changesScope: 'turn' }), 'turn');
  assert.equal(changesScope({}, { changesScope: 'turn' }, false), 'branch');
  assert.equal(changesScope({ scope: 'uncommitted', turnId: 'old' }), 'uncommitted');
});

test('last turn only overrides every other scope', () => {
  assert.equal(changesScope({ scope: 'branch' }, { changesLastTurnOnly: true, changesScope: 'uncommitted' }), 'turn');
  assert.equal(changesScope({}, { changesLastTurnOnly: true }, false), 'turn');
});

test('explicit turn links and user-selected scopes retain their scope', () => {
  assert.equal(changesScope({ turnId: 'edit' }), 'turn');
  assert.equal(changesScope({ scope: 'turn' }), 'turn');
  assert.equal(changesScope({ scope: 'branch' }), 'branch');
});
