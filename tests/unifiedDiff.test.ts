// Parsing git diffs and Codex file changes into the rows the diff view renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFileText, diffLineText, fileChangeToDiff, parseUnifiedDiff } from '../src/lib/diff.ts';

test('Git-quoted UTF-8 filenames are decoded in text diffs and binary renames', () => {
  const oldPath = '"a/\\344\\275\\240\\345\\245\\275.txt"';
  const newPath = '"b/tab\\tquote\\"slash\\\\.txt"';
  const text = parseUnifiedDiff(`diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-old\n+new`)[0];
  assert.equal(text.oldPath, '你好.txt');
  assert.equal(text.path, 'tab\tquote"slash\\.txt');
  assert.equal(text.added, 1);
  const binary = parseUnifiedDiff(`diff --git ${oldPath} ${newPath}\nBinary files differ`)[0];
  assert.equal(binary.oldPath, text.oldPath);
  assert.equal(binary.path, text.path);
  assert.equal(binary.binary, true);
});

test('Git paths with spaces remain intact and either header path can be quoted', () => {
  for (const header of [
    'diff --git a/old name.txt b/new name.txt',
    'diff --git "a/old name.txt" b/new name.txt',
    'diff --git a/old name.txt "b/new name.txt"',
  ]) {
    const file = parseUnifiedDiff(`${header}\nBinary files differ`)[0];
    assert.equal(file.oldPath, 'old name.txt');
    assert.equal(file.path, 'new name.txt');
  }
});

test('unchanged path names containing a b/ separator are not split into invented renames', () => {
  for (const body of ['Binary files differ\n', '--- a/dir b/file.txt\n+++ b/dir b/file.txt\n@@ -1 +1 @@\n-old\n+new\n']) {
    const [file] = parseUnifiedDiff('diff --git a/dir b/file.txt b/dir b/file.txt\n' + body);
    assert.equal(file.path, 'dir b/file.txt');
    assert.equal(file.oldPath, 'dir b/file.txt');
    assert.doesNotMatch(diffFileText(file), /rename from/);
  }
});

test('rename and copy metadata disambiguate paths and preserve the operation', () => {
  for (const operation of ['rename', 'copy']) {
    const [file] = parseUnifiedDiff(
      `diff --git a/old b/name.txt b/new b/name.txt\n${operation} from old b/name.txt\n${operation} to new b/name.txt\n`,
    );
    assert.equal(file.oldPath, 'old b/name.txt');
    assert.equal(file.path, 'new b/name.txt');
    assert.ok(diffFileText(file).includes(`${operation} from "old b/name.txt"\n${operation} to "new b/name.txt"`));
    if (operation === 'copy') assert.doesNotMatch(diffFileText(file), /rename from/);
  }
});

test('a multi-file git diff numbers old and new lines and counts edits per file', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,4 +3,5 @@ function f() {',
      ' keep',
      '-old',
      '+new',
      '+more',
      '\\ No newline at end of file',
      '',
      ' after blank',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.added, f.removed, !!f.isNew, !!f.isDeleted, !!f.binary]),
    [
      ['src/a.ts', 'src/a.ts', 2, 1, false, false, false],
      ['new.txt', 'new.txt', 1, 0, true, false, false],
      ['gone.txt', 'gone.txt', 0, 1, false, true, false],
      ['img.png', 'img.png', 0, 0, false, false, true],
    ],
  );
  assert.deepEqual(files[0].lines, [
    { kind: 'hunk', text: '@@ -3,4 +3,5 @@ function f() {' },
    { kind: 'ctx', text: 'keep', oldNo: 3, newNo: 3 },
    { kind: 'del', text: 'old', oldNo: 4 },
    { kind: 'add', text: 'new', newNo: 4 },
    { kind: 'add', text: 'more', newNo: 5, noNewline: true },
    { kind: 'ctx', text: '', oldNo: 5, newNo: 6 }, // a blank line inside a hunk is context
    { kind: 'ctx', text: 'after blank', oldNo: 6, newNo: 7 },
  ]);
});

test('a header without a b/ path keeps the raw name; lines before any file are skipped', () => {
  const [f] = parseUnifiedDiff('preamble\ndiff --git weird\n@@ bogus @@\n+x');
  assert.equal(f.path, 'weird');
  assert.equal(f.oldPath, undefined);
  assert.deepEqual(f.lines, [
    { kind: 'hunk', text: '@@ bogus @@' },
    { kind: 'add', text: 'x', newNo: 0 },
  ]);
});

test('a bare patch starting at --- or @@ opens a file; an empty one is dropped', () => {
  assert.equal(parseUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b')[0].path, 'x.ts');
  const [hunkOnly] = parseUnifiedDiff('@@ -1 +1 @@\n-a');
  assert.equal(hunkOnly.path, '');
  assert.equal(hunkOnly.removed, 1);
  assert.deepEqual(parseUnifiedDiff('--- /dev/null'), []);
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('multi-file bare patches start a new file only after both hunk counts are consumed', () => {
  const files = parseUnifiedDiff(
    [
      '--- a/first.txt',
      '+++ b/first.txt',
      '@@ -1,2 +1,2 @@',
      '--- heading',
      '+++ heading',
      ' unchanged',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+new',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed, !!f.isNew, !!f.isDeleted]),
    [
      ['first.txt', 1, 1, false, false],
      ['new.txt', 1, 0, true, false],
      ['gone.txt', 0, 1, false, true],
    ],
  );
  assert.deepEqual(
    files[0].lines.slice(1).map((line) => line.text),
    ['-- heading', '++ heading', 'unchanged'],
  );
});

test('an unmatched header-like line after a hunk is retained rather than opening an incomplete file', () => {
  const files = parseUnifiedDiff('--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n--- extra');
  assert.equal(files.length, 1);
  assert.equal(files[0].lines.at(-1)!.text, '-- extra');
});

test('missing final-newline markers belong to the preceding edit without changing line counts', () => {
  const [file] = parseUnifiedDiff(
    '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
  );
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
  assert.equal((file.lines[1] as any).noNewline, true);
  assert.equal((file.lines[2] as any).noNewline, true);
});

test('orphan newline markers do not annotate missing lines or hunk headers', () => {
  const [file] = parseUnifiedDiff('diff --git a/x b/x\n\\ No newline at end of file\n@@ -0,0 +0,0 @@\n\\ No newline at end of file\n');
  assert.deepEqual(file.lines, [{ kind: 'hunk', text: '@@ -0,0 +0,0 @@' }]);
});

test('diff line serialization keeps signs and newline control records', () => {
  assert.equal(diffLineText({ kind: 'add', text: 'x', noNewline: true }), '+x\n\\ No newline at end of file');
  assert.equal(diffLineText({ kind: 'del', text: 'x' }), '-x');
  assert.equal(diffLineText({ kind: 'ctx', text: 'x' }), ' x');
  assert.equal(diffLineText({ kind: 'hunk', text: '@@ header @@' }), '@@ header @@');
  assert.equal(diffLineText({ kind: 'meta', text: 'metadata' }), 'metadata');
  for (const kind of ['add', 'delete']) {
    const raw = fileChangeToDiff({ path: 'x', kind, diff: 'raw content' });
    assert.equal(raw.lines[0].noNewline, true);
    assert.equal(fileChangeToDiff({ path: 'x', kind, diff: 'raw content\n' }).lines[0].noNewline, undefined);
  }
});

test('file serialization creates raw-content hunks and retains empty-file modes', () => {
  for (const kind of ['add', 'delete']) {
    const raw = fileChangeToDiff({ path: 'file.txt', kind, diff: 'text' });
    const roundtrip = parseUnifiedDiff(diffFileText(raw))[0];
    assert.equal(roundtrip.added, raw.added);
    assert.equal(roundtrip.removed, raw.removed);
    assert.equal(roundtrip.lines.at(-1)!.noNewline, true);
    const empty = fileChangeToDiff({ path: 'empty.txt', kind, diff: '' });
    assert.equal(parseUnifiedDiff(diffFileText(empty))[0].path, 'empty.txt');
    empty.mode = '100755';
    assert.match(diffFileText(empty), /file mode 100755/);
    const parsed = parseUnifiedDiff(diffFileText(empty))[0];
    assert.equal(parsed.mode, '100755');
    assert.equal(parsed.lines.length, 0);
  }
});

test('file serialization preserves rename metadata and keeps binary changes informational', () => {
  const renamed = { path: 'new name.txt', oldPath: 'old name.txt', lines: [], added: 0, removed: 0 };
  assert.equal(
    diffFileText(renamed),
    'diff --git "a/old name.txt" "b/new name.txt"\nrename from "old name.txt"\nrename to "new name.txt"\n',
  );
  const binary = { path: 'image.bin', lines: [], added: 0, removed: 0, binary: true };
  assert.match(diffFileText(binary), /Binary files a\/image.bin and b\/image.bin differ/);
  assert.match(diffFileText({ ...binary, isNew: true }), /Binary files \/dev\/null and b\/image.bin differ/);
  assert.equal(diffFileText({ path: 'empty', lines: [], added: 0, removed: 0 }), '--- a/empty\n+++ b/empty\n\n');
});

test('permission-only and combined content changes preserve both Git modes', () => {
  for (const body of ['', '--- a/script.sh\n+++ b/script.sh\n@@ -1 +1 @@\n-old\n+new\n']) {
    const original = 'diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n' + body;
    const [file] = parseUnifiedDiff(original);
    assert.equal((file as any).oldMode, '100644');
    assert.equal((file as any).newMode, '100755');
    assert.equal(diffFileText(file), original);
  }
});

test('available mode records are retained without inventing a missing counterpart', () => {
  for (const record of ['old mode 100644', 'new mode 100755']) {
    const original = 'diff --git a/file b/file\n' + record + '\n';
    assert.equal(diffFileText(parseUnifiedDiff(original)[0]), original);
  }
  const rename = 'diff --git a/old b/new\nold mode 100644\nnew mode 100755\n';
  assert.match(diffFileText(parseUnifiedDiff(rename)[0]), /rename from old\nrename to new\nold mode 100644\nnew mode 100755\n/);
});

test('hunk content starting with header markers is counted as edits rather than file names', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/first.txt b/first.txt',
      '--- a/first.txt',
      '+++ b/first.txt',
      '@@ -1,2 +1,2 @@',
      '--- old heading',
      '+++ new heading',
      '--- /dev/null',
      '+++ b/not-a-file.txt',
      'diff --git a/second.txt b/second.txt',
      '--- a/second.txt',
      '+++ b/second.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed]),
    [
      ['first.txt', 2, 2],
      ['second.txt', 1, 1],
    ],
  );
  assert.deepEqual(files[0].lines.slice(1), [
    { kind: 'del', text: '-- old heading', oldNo: 1 },
    { kind: 'add', text: '++ new heading', newNo: 1 },
    { kind: 'del', text: '-- /dev/null', oldNo: 2 },
    { kind: 'add', text: '++ b/not-a-file.txt', newNo: 2 },
  ]);
});

test('an added or deleted file given as raw content becomes all-add or all-del rows', () => {
  const added = fileChangeToDiff({ path: 'n.ts', kind: { type: 'add' }, diff: 'a\nb\n' });
  assert.deepEqual(added, {
    path: 'n.ts',
    lines: [
      { kind: 'add', text: 'a', newNo: 1 },
      { kind: 'add', text: 'b', newNo: 2 },
    ],
    added: 2,
    removed: 0,
    isNew: true,
  });
  assert.equal(fileChangeToDiff({ path: 'n.ts', kind: 'add', diff: 'a' }).added, 1);
  const deleted = fileChangeToDiff({ path: 'd.ts', kind: 'delete', diff: 'x' });
  assert.deepEqual(deleted, {
    path: 'd.ts',
    lines: [{ kind: 'del', text: 'x', oldNo: 1, noNewline: true }],
    added: 0,
    removed: 1,
    isDeleted: true,
  });
  const deletedNl = fileChangeToDiff({ path: 'd.ts', kind: 'delete', diff: 'x\n' });
  assert.equal(deletedNl.removed, 1);
});

test('empty raw files have no changed lines, while a newline represents a blank line', () => {
  for (const kind of ['add', 'delete']) {
    for (const diff of ['', undefined]) {
      const file = fileChangeToDiff({ path: 'empty.txt', kind, diff: diff as any });
      assert.deepEqual(file.lines, []);
      assert.equal(file.added, 0);
      assert.equal(file.removed, 0);
      assert.equal(kind === 'add' ? file.isNew : file.isDeleted, true);
    }
    for (const count of [1, 2]) {
      const file = fileChangeToDiff({ path: 'blank.txt', kind, diff: '\n'.repeat(count) });
      assert.equal(file.lines.length, count);
      assert.equal(file.added, kind === 'add' ? count : 0);
      assert.equal(file.removed, kind === 'delete' ? count : 0);
      assert.ok(file.lines.every((line) => line.text === ''));
    }
  }
});

test('raw Markdown, YAML, and marker-like text retain every added or deleted line', () => {
  for (const kind of ['add', 'delete']) {
    for (const diff of [
      '---\ntitle: Example\n---\n',
      'Heading\n---\nBody\n',
      '@@decorator\nvalue\n',
      '--- separator\nplain text\n',
      'diff --git documentation\nexample\n',
      'Intro\n@@ -1 +1 @@\n-old\n+new\n',
    ]) {
      const expected = diff.slice(0, -1).split('\n');
      const file = fileChangeToDiff({ path: 'document.txt', kind, diff });
      assert.deepEqual(
        file.lines.map((line) => line.text),
        expected,
      );
      assert.equal(file.added, kind === 'add' ? expected.length : 0);
      assert.equal(file.removed, kind === 'delete' ? expected.length : 0);
    }
  }
});

test('a valid bare hunk remains a patch even for added or deleted files', () => {
  const added = fileChangeToDiff({ path: 'new.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+hello\n' });
  assert.equal(added.added, 1);
  assert.equal(added.lines[1].text, 'hello');
  const deleted = fileChangeToDiff({ path: 'gone.txt', kind: 'delete', diff: '@@ -1 +0,0 @@\n-hello\n' });
  assert.equal(deleted.removed, 1);
  assert.equal(deleted.lines[1].text, 'hello');
});

test('an update hunk is parsed under the change path; a missing diff is an empty file', () => {
  const upd = fileChangeToDiff({ path: '/repo/u.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' });
  assert.equal(upd.path, '/repo/u.ts');
  assert.equal(upd.added, 1);
  assert.equal(upd.removed, 1);
  assert.equal(upd.isNew, undefined);
  const empty = fileChangeToDiff({ path: 'e.ts', kind: undefined, diff: undefined as any });
  assert.deepEqual(empty, { path: 'e.ts', lines: [], added: 0, removed: 0, isNew: undefined, isDeleted: undefined });
  const full = fileChangeToDiff({
    path: 'f.ts',
    kind: 'add',
    diff: 'diff --git a/f.ts b/f.ts\nnew file mode 100644\n--- /dev/null\n+++ b/f.ts\n@@ -0,0 +1 @@\n+z',
  });
  assert.equal(full.isNew, true);
  assert.equal(full.added, 1);
  const del = fileChangeToDiff({ path: 'g.ts', kind: 'delete', diff: '--- a/g.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z' });
  assert.equal(del.isDeleted, true);
});

test('bare hunks preserve unusual filenames in both sides of the generated patch', () => {
  for (const path of ['line\nbreak.txt', 'tab\tname.txt', 'quote"name.txt', 'slash\\name.txt']) {
    const file = fileChangeToDiff({ path, kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' });
    assert.equal(file.oldPath, path);
    assert.equal(file.path, path);
    const copied = parseUnifiedDiff(diffFileText(file))[0];
    assert.equal(copied.oldPath, path);
    assert.equal(copied.path, path);
    assert.equal(copied.added, 1);
    assert.equal(copied.removed, 1);
  }
});

test('encoded Git binary patches are identified without swallowing the next text diff', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/image.bin b/image.bin',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 3',
      'KcmZQzU|?Vb00001',
      '',
      'literal 0',
      'HcmV?d00001',
      '',
      'diff --git a/text.txt b/text.txt',
      '--- a/text.txt',
      '+++ b/text.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'),
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].path, 'image.bin');
  assert.deepEqual(files[0].lines, []);
  assert.equal(files[0].added, 0);
  assert.equal(files[0].removed, 0);
  assert.equal(files[1].path, 'text.txt');
  assert.equal(files[1].added, 1);
  assert.equal(files[1].removed, 1);
});

test('timestamped unified headers retain filenames and recognize additions and deletions', () => {
  const stamp = '\t2026-10-12 10:00:00.000000000 -0700';
  for (const [from, to, expected, isNew, isDeleted] of [
    ['a/space name.txt', 'b/space name.txt', 'space name.txt', false, false],
    ['/dev/null', 'b/new.txt', 'new.txt', true, false],
    ['a/gone.txt', '/dev/null', 'gone.txt', false, true],
    ['"a/tab\\tname.txt"', '"b/tab\\tname.txt"', 'tab\tname.txt', false, false],
  ] as const) {
    const body = isNew ? '@@ -0,0 +1 @@\n+new\n' : isDeleted ? '@@ -1 +0,0 @@\n-old\n' : '@@ -1 +1 @@\n-old\n+new\n';
    const [file] = parseUnifiedDiff(`--- ${from}${stamp}\n+++ ${to}${stamp}\n${body}`);
    assert.equal(file.path, expected);
    assert.equal(!!file.isNew, isNew);
    assert.equal(!!file.isDeleted, isDeleted);
    assert.ok(!diffFileText(file).includes('2026-10-12'));
  }
});

test('blank separators after completed hunks do not become copied context lines', () => {
  const patch =
    '--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-old\n+new\n\n--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-old\n+new\n\n';
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(
    files.map((file) => file.lines.map((line) => line.kind)),
    [
      ['hunk', 'del', 'add'],
      ['hunk', 'del', 'add'],
    ],
  );
  assert.equal(files.map(diffFileText).join(''), patch.replaceAll('\n\n', '\n'));
});

test('padding inside truncated one-sided hunks does not invent context from the missing side', () => {
  for (const [hunk, edit, kind] of [
    ['@@ -0,0 +1,2 @@', '+new', 'add'],
    ['@@ -1,2 +0,0 @@', '-old', 'del'],
  ] as const) {
    const [file] = parseUnifiedDiff(`--- a/x.txt\n+++ b/x.txt\n${hunk}\n${edit}\n\n`);
    assert.deepEqual(
      file.lines.map((line) => line.kind),
      ['hunk', kind],
    );
  }
});

test('reuseDiffFiles keeps unchanged files as they were, and the list itself when nothing changed (#2049)', async () => {
  const { reuseDiffFiles } = await import('../src/lib/diff.ts');
  const read = () =>
    parseUnifiedDiff(
      ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-a', '+b', '--- a/b.ts', '+++ b/b.ts', '@@ -1 +1 @@', '-c', '+d'].join('\n'),
    );
  const first = read();
  assert.equal(reuseDiffFiles(first, read()), first, 'the same diff read again: the same list');
  const edited = read();
  edited[1] = { ...edited[1], lines: [...edited[1].lines, { kind: 'add', text: 'e', newNo: 2 }], added: 2 };
  const kept = reuseDiffFiles(first, edited);
  assert.notEqual(kept, first);
  assert.equal(kept[0], first[0], 'the unchanged file keeps its object, so its colors are not redone');
  assert.equal(kept[1], edited[1]);
  assert.deepEqual(reuseDiffFiles(first, [read()[0]]), [first[0]], 'a file gone: a new list');
  const swapped = reuseDiffFiles(first, [read()[1], read()[0]]);
  assert.notEqual(swapped, first, 'the same files in another order: a new list in that order');
  assert.deepEqual(swapped, [first[1], first[0]]);
  assert.equal(reuseDiffFiles([], []).length, 0);
});
