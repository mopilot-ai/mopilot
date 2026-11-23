// ACP file edits as fileChange items (#1942): opencode's write (no diff block), its edit (fragment diff blocks with the
// real patch in rawOutput.metadata.diff), and edits a spec-following agent sends as whole-file diff blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AcpRecord } from '../shared/acpItems/records.d.mts';
import { AcpTranslator, buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { toolItem as toolItemTyped } from '../src/harness/acpTranslate.ts';
import { editChanges, patchChanges } from '../shared/acpItems/editChanges.mjs';
import { turnDiffFiles } from '../src/lib/turnDiff.ts';
import { fileChangePatch } from '../src/lib/fileChangePatch.ts';

const toolItem = (tc: unknown, cwd = '/p'): any => toolItemTyped(tc, cwd);

// opencode 1.18.35, as captured from `opencode acp` (paths shortened)
const writeRunning = {
  toolCallId: 'w',
  status: 'in_progress',
  kind: 'edit',
  title: 'write',
  locations: [{ path: '/p/greet.py' }],
  rawInput: { filePath: '/p/greet.py', content: 'def greet(name):\n    return name\n' },
};
const writeDone = (exists: boolean) => ({
  status: 'completed',
  title: 'p/greet.py',
  content: [{ type: 'content', content: { type: 'text', text: 'Wrote file successfully.' } }],
  rawOutput: { output: 'Wrote file successfully.', metadata: { diagnostics: {}, filepath: '/p/greet.py', exists, truncated: false } },
});
const opencodePatch =
  'Index: /p/greet.py\n===================================================================\n--- /p/greet.py\n+++ /p/greet.py\n' +
  '@@ -1,5 +1,5 @@\n def greet(name):\n-    return "hi " + name\n+    return f"Hello, {name}!"\n \n \n print(greet("x"))\n';
const editRunning = {
  toolCallId: 'e',
  status: 'in_progress',
  kind: 'edit',
  title: 'edit',
  locations: [{ path: '/p/greet.py' }],
  rawInput: { filePath: '/p/greet.py', oldString: '"hi " + name', newString: 'f"Hello, {name}!"' },
};
const editDone = {
  status: 'completed',
  title: 'p/greet.py',
  content: [
    { type: 'content', content: { type: 'text', text: 'Edit applied successfully.' } },
    { type: 'diff', path: '/p/greet.py', oldText: '"hi " + name', newText: 'f"Hello, {name}!"' },
  ],
  rawOutput: { output: 'Edit applied successfully.', metadata: { diagnostics: {}, diff: opencodePatch } },
};

test('#1942: an opencode write is a new file with its content, running and done', () => {
  const running = toolItem(writeRunning);
  assert.equal(running.type, 'fileChange');
  assert.equal(running.status, 'inProgress');
  assert.deepEqual(running.changes, [{ path: '/p/greet.py', kind: { type: 'add' }, diff: 'def greet(name):\n    return name\n' }]);
  const done = toolItem({ ...writeRunning, ...writeDone(false) });
  assert.equal(done.type, 'fileChange');
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.changes, running.changes);
});

test('#1942: an opencode write over an existing file is an update with no patch, so Undo never empties it', () => {
  const done = toolItem({ ...writeRunning, ...writeDone(true) });
  assert.equal(done.type, 'fileChange');
  assert.deepEqual(done.changes, [{ path: '/p/greet.py', kind: { type: 'update', move_path: null }, diff: '' }]);
  // nothing to reverse-apply: the Edited card reports no patch data rather than truncating the file
  assert.equal(fileChangePatch(done.changes[0], '/p'), '');
});

test('#1942: an opencode edit reads its input while running and the real patch, with line numbers, when done', () => {
  const running = toolItem(editRunning);
  assert.equal(running.type, 'fileChange');
  assert.deepEqual(running.changes, [
    { path: '/p/greet.py', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-"hi " + name\n+f"Hello, {name}!"' },
  ]);
  const done = toolItem({ ...editRunning, ...editDone });
  assert.deepEqual(done.changes, [
    {
      path: '/p/greet.py',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1,5 +1,5 @@\n def greet(name):\n-    return "hi " + name\n+    return f"Hello, {name}!"\n \n \n print(greet("x"))',
    },
  ]);
  // Undo gets a relative, applicable patch, not the absolute "Index:" one
  assert.match(
    fileChangePatch(done.changes[0], '/p'),
    /^diff --git a\/greet\.py b\/greet\.py\n--- a\/greet\.py\n\+\+\+ b\/greet\.py\n@@ -1,5 \+1,5 @@/,
  );
});

test('#1942: a write that finished without saying the file was new (the turn ended first) has no patch', () => {
  const ended = toolItem({ ...writeRunning, status: 'completed' });
  assert.deepEqual(ended.changes, [{ path: '/p/greet.py', kind: { type: 'update', move_path: null }, diff: '' }]);
  assert.equal(toolItem({ ...writeRunning, status: 'failed' }).changes[0].diff, '');
  // while it runs, an overwrite the agent already named is no new file either
  assert.equal(toolItem({ ...writeRunning, rawOutput: { metadata: { exists: true } } }).changes[0].kind.type, 'update');
  // a turn that ends with the write still running: the write is closed without a patch Undo could delete the file with
  const out: any[] = [];
  const tr = new AcpTranslator('acp:opencode:1', '/p', (m, p) => out.push([m, p]));
  tr.beginTurn('t1');
  tr.onUpdate({ sessionUpdate: 'tool_call_update', ...writeRunning });
  tr.endTurn('end_turn', null);
  const last = out.filter(([m, p]) => m === 'item/completed' && p.item.id === 'w').at(-1)[1].item;
  assert.equal(last.status, 'completed');
  assert.deepEqual(last.changes, [{ path: '/p/greet.py', kind: { type: 'update', move_path: null }, diff: '' }]);
});

test('#1942: Claude-style input names and the first location also give the path', () => {
  const claude = toolItem({ toolCallId: 'c', kind: 'edit', rawInput: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } });
  assert.deepEqual(claude.changes[0], { path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' });
  const byPath = toolItem({ toolCallId: 'c', kind: 'edit', status: 'pending', rawInput: { path: '/p/b.ts', content: 'x' } });
  assert.deepEqual(byPath.changes[0], { path: '/p/b.ts', kind: { type: 'add' }, diff: 'x' });
  const byLocation = toolItem({ toolCallId: 'c', kind: 'edit', locations: [{ path: '/p/c.ts' }], rawInput: { content: 'y' } });
  assert.equal(byLocation.changes[0].path, '/p/c.ts');
  // a deletion with no replacement string is still an update
  const cut = toolItem({ toolCallId: 'c', kind: 'edit', rawInput: { filePath: '/p/d.ts', oldString: 'gone' } });
  assert.equal(cut.changes[0].diff, '@@ -1,1 +1,1 @@\n-gone\n+');
});

test('#1942: an edit with no file yet, or input it cannot read, stays a generic tool card', () => {
  assert.equal(toolItem({ toolCallId: 'c', kind: 'edit', title: 'edit', status: 'pending', rawInput: {} }).type, 'mcpToolCall');
  assert.equal(
    toolItem({ toolCallId: 'c', kind: 'edit', locations: [{ path: '/p/x' }], rawInput: { patchText: '*** Begin Patch' } }).type,
    'mcpToolCall',
  );
  assert.equal(toolItem({ toolCallId: 'c', kind: 'edit', locations: [], rawInput: { filePath: 7, content: 'x' } }).type, 'mcpToolCall');
  assert.equal(toolItem({ toolCallId: 'c', kind: 'edit' }).type, 'mcpToolCall');
  // other kinds never read edit input
  assert.equal(toolItem({ toolCallId: 'c', kind: 'other', rawInput: { filePath: '/p/a', content: 'x' } }).type, 'mcpToolCall');
});

test('#1942: whole-file diff blocks (spec ACP agents) keep their mapping when no patch is given', () => {
  const item = toolItem({
    toolCallId: 'd',
    kind: 'edit',
    status: 'completed',
    content: [
      { type: 'diff', path: '/p/a', oldText: 'a', newText: 'b' },
      { type: 'diff', path: '/p/n', oldText: null, newText: 'n' },
    ],
    rawOutput: { metadata: { diff: 'not a patch' } },
  });
  assert.deepEqual(item.changes, [
    { path: '/p/a', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' },
    { path: '/p/n', kind: { type: 'add' }, diff: 'n' },
  ]);
});

test('#1942: a multi-file patch maps each file, new and deleted ones included', () => {
  const patch =
    'Index: /p/a\n====\n--- /p/a\t(before)\n+++ /p/a\t(after)\n@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n' +
    'Index: /p/new\n====\n--- /dev/null\n+++ /p/new\n@@ -0,0 +1 @@\n+n\n' +
    '--- /p/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n' +
    '--- /p/empty\n+++ /p/empty\n';
  assert.deepEqual(patchChanges(patch), [
    { path: '/p/a', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file' },
    { path: '/p/new', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+n' },
    { path: '/p/gone', kind: { type: 'delete' }, diff: '@@ -1 +0,0 @@\n-g' },
  ]);
  assert.deepEqual(patchChanges(42), []);
  // a hunk's lines are counted: a removed "-- x" then an added "++ y" are content, and empty context lines count
  assert.deepEqual(patchChanges('\\ stray\n--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,3 @@\n keep\n--- old\n+++ new\n\n'), [
    { path: 'q.sql', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n keep\n--- old\n+++ new\n' },
  ]);
  assert.deepEqual(patchChanges('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+1\n+2\n'), [
    { path: 'n.txt', kind: { type: 'add' }, diff: '@@ -0,0 +1,2 @@\n+1\n+2' },
  ]);
  assert.deepEqual(editChanges({ kind: 'read', rawInput: { filePath: '/p/a', content: 'x' } }, []), []);
  // a new file's block with no text is an empty new file
  assert.deepEqual(editChanges({ kind: 'edit' }, [{ type: 'diff', path: '/p/e', oldText: null }]), [
    { path: '/p/e', kind: { type: 'add' }, diff: '' },
  ]);
  // a patch whose files it cannot place falls back to the diff blocks
  const blocks = [{ type: 'diff', path: '/p/a', oldText: null, newText: 'z' }];
  assert.deepEqual(editChanges({ kind: 'edit', rawOutput: { metadata: { diff: '--- /p/a\n+++ /p/a\n' } } }, blocks), [
    { path: '/p/a', kind: { type: 'add' }, diff: 'z' },
  ]);
});

test('#1942: the opencode repro turn shows an edit, the Edited card files and Changes, live and read back', () => {
  const at = 'at-1';
  const records: AcpRecord[] = [
    {
      t: 'user',
      turnId: at,
      user: { id: 'u', clientId: 'c', content: [{ type: 'text', text: 'create greet.py', text_elements: [] }] },
      at: 1,
    },
    {
      t: 'update',
      turnId: at,
      update: { sessionUpdate: 'tool_call', toolCallId: 'w', title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} },
      at: 2,
    },
    { t: 'update', turnId: at, update: { sessionUpdate: 'tool_call_update', ...writeRunning }, at: 3 },
    { t: 'update', turnId: at, update: { sessionUpdate: 'tool_call_update', toolCallId: 'w', ...writeDone(false) }, at: 4 },
    { t: 'end', turnId: at, stopReason: 'end_turn', error: null, at: 5 },
  ];
  const [turn] = buildAcpTurns(records, 'acp:opencode:1', '/p');
  const items = turn.items.filter((i: any) => i.id === 'w');
  assert.equal(items.length, 1);
  assert.equal((items[0] as any).type, 'fileChange');
  assert.equal((items[0] as any).status, 'completed');
  // a folder with no Git snapshot: the Edited card and Changes read the turn's file change items
  const files = turnDiffFiles({ diff: undefined, items: turn.items as any });
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed, f.isNew]),
    [['/p/greet.py', 2, 0, true]],
  );

  // live: the same item id goes from the generic card to the edit in place
  const out: any[] = [];
  const tr = new AcpTranslator('acp:opencode:1', '/p', (m, p) => out.push([m, p]));
  for (const r of records) {
    if (r.t === 'user') tr.beginTurn(r.turnId, r.user);
    else if (r.t === 'update') tr.onUpdate(r.update, r.turnId);
  }
  assert.deepEqual(
    out.filter(([m, p]) => m.startsWith('item/') && p.item.id === 'w').map(([m, p]) => [m, p.item.type, p.item.status]),
    [
      ['item/started', 'mcpToolCall', 'inProgress'],
      ['item/completed', 'fileChange', 'inProgress'],
      ['item/completed', 'fileChange', 'completed'],
    ],
  );
});
