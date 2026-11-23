// Two edits to one file in a turn are one file in the Last Turn diff, not only the last edit (D-68).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDiffFile } from '../src/lib/diffMerge.ts';

const line = (kind: 'add' | 'del' | 'ctx' | 'hunk', text: string) => ({ kind, text });

test('later edits follow earlier ones and the counts add up', () => {
  const a = { path: '/p/a.ts', lines: [line('hunk', '@@ -1 +1 @@'), line('del', 'x'), line('add', 'y')], added: 1, removed: 1 };
  const b = { path: '/p/a.ts', lines: [line('hunk', '@@ -5 +5 @@'), line('add', 'z')], added: 1, removed: 0 };
  const m = mergeDiffFile(a, b);
  assert.deepEqual(
    m.lines.map((l) => l.text),
    ['@@ -1 +1 @@', 'x', 'y', '@@ -5 +5 @@', 'z'],
  );
  assert.equal(m.added, 2);
  assert.equal(m.removed, 1);
});

test('a file created and then edited stays new; one deleted last is deleted', () => {
  const created = { path: 'n', lines: [line('add', 'a')], added: 1, removed: 0, isNew: true };
  const edit = { path: 'n', lines: [line('add', 'b')], added: 1, removed: 0 };
  assert.equal(mergeDiffFile(created, edit).isNew, true);
  const gone = { path: 'n', lines: [line('del', 'a')], added: 0, removed: 1, isDeleted: true };
  assert.equal(mergeDiffFile(created, gone).isDeleted, true);
});

test('later binary and file-mode metadata survive repeated-edit merging', () => {
  const first = { path: 'f', lines: [], added: 0, removed: 0 };
  const later = { ...first, binary: true, mode: '100755', oldMode: '100644', newMode: '100755' };
  const merged = mergeDiffFile(first, later);
  assert.equal(merged.binary, true);
  assert.equal(merged.mode, '100755');
  assert.equal(merged.oldMode, '100644');
  assert.equal(merged.newMode, '100755');
  const final = mergeDiffFile(merged, { ...first, binary: false, oldMode: '100755', newMode: '100644' });
  assert.equal(final.binary, false);
  assert.equal(final.mode, '100755');
  assert.equal(final.oldMode, '100644');
  assert.equal(final.newMode, '100644');
  const noMetadata = mergeDiffFile(first, first);
  assert.equal(noMetadata.binary, undefined);
  assert.equal(noMetadata.mode, undefined);
  assert.equal(noMetadata.oldMode, undefined);
  assert.equal(noMetadata.newMode, undefined);
});
