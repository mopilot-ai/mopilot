// File-change patch serialization covers raw contents, empty files, quoted paths and existing patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileChangePatch } from '../src/lib/fileChangePatch.ts';
import { parseUnifiedDiff } from '../src/lib/diff.ts';

test('empty creates and deletes produce mode records without phantom content', () => {
  for (const kind of ['add', 'delete']) {
    const patch = fileChangePatch({ path: '/repo/empty.txt', kind, diff: '' }, '/repo');
    assert.equal(patch, `diff --git a/empty.txt b/empty.txt\n${kind === 'add' ? 'new' : 'deleted'} file mode 100644\n`);
  }
});

test('raw content retains trailing-newline state and Markdown separators', () => {
  for (const kind of ['add', 'delete']) {
    for (const text of ['hello', 'hello\n', 'title\n---\nbody\n']) {
      const patch = fileChangePatch({ path: '/repo/name.txt', kind, diff: text }, '/repo');
      const file = parseUnifiedDiff(patch)[0];
      assert.equal(file.path, 'name.txt');
      assert.equal(
        file.lines
          .filter((line) => line.kind !== 'hunk')
          .map((line) => line.text)
          .join('\n'),
        text.replace(/\n$/, ''),
      );
      assert.equal(!!file.lines.at(-1)?.noNewline, !text.endsWith('\n'));
    }
  }
});

test('bare hunks and raw content quote unusual filenames', () => {
  for (const path of ['line\nbreak.txt', 'tab\tname.txt', 'quote"name.txt', 'slash\\name.txt']) {
    for (const [kind, diff] of [
      ['add', 'hello'],
      ['update', '@@ -1 +1 @@\n-old\n+new\n'],
    ]) {
      const file = parseUnifiedDiff(fileChangePatch({ path: '/repo/' + path, kind, diff }, '/repo'))[0];
      assert.equal(file.path, path);
    }
  }
});

test('existing full patches are preserved, and missing updates are omitted', () => {
  for (const patch of ['diff --git a/f b/f\nBinary files a/f and b/f differ\n', '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n']) {
    assert.equal(fileChangePatch({ path: '/repo/f', diff: patch }, '/repo'), patch);
  }
  assert.equal(fileChangePatch({ path: '/repo/f' }, '/repo'), '');
  assert.equal(fileChangePatch({ path: '/repo/f', diff: null }, '/repo'), '');
});

test('Windows relative paths use Git separators without changing POSIX backslashes', () => {
  const file = parseUnifiedDiff(fileChangePatch({ path: 'C:\\repo\\dir\\new.txt', kind: 'add', diff: 'hello\n' }, 'C:\\repo'))[0];
  assert.equal(file.path, 'dir/new.txt');
});
