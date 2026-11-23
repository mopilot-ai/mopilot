// The review methods' diff reader: files with status and counts, rows with word marks, quoted paths, paging and the size caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDiff, pageOf, withWordMarks, MAX_LINE, MAX_PAGE_CHARS } = require('../electron/remote/review/diffRows.cjs');

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-const total = price * 2;
+const total = price * 3;
 tail
\\ No newline at end of file
`;

test('a modified file: status, counts, numbered rows and the no-newline note', () => {
  const [f] = parseDiff(MODIFIED);
  assert.deepEqual(
    { path: f.path, status: f.status, added: f.added, removed: f.removed, binary: f.binary },
    { path: 'src/a.ts', status: 'modified', added: 1, removed: 1, binary: false },
  );
  assert.deepEqual(f.rows[0], { k: 'hunk', t: '@@ -1,3 +1,3 @@' });
  assert.deepEqual(f.rows[1], { k: 'ctx', t: 'keep', o: 1, n: 1 });
  assert.deepEqual(f.rows[2], { k: 'del', t: 'const total = price * 2;', o: 2 });
  assert.deepEqual(f.rows[3], { k: 'add', t: 'const total = price * 3;', n: 2 });
  assert.deepEqual(f.rows.at(-1), { k: 'meta', t: 'No newline at end of file' });
});

test('added, deleted, renamed, copied and binary files', () => {
  const text = [
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
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to new name.txt',
    'diff --git a/copy.txt b/copy2.txt',
    'copy from copy.txt',
    'copy to copy2.txt',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/blob.bin b/blob.bin',
    'GIT binary patch',
    'literal 3',
    '',
  ].join('\n');
  const files = parseDiff(text);
  assert.deepEqual(
    files.map((f: any) => [f.path, f.oldPath, f.status, f.binary]),
    [
      ['new.txt', undefined, 'added', false],
      ['gone.txt', undefined, 'deleted', false],
      ['new name.txt', 'old name.txt', 'renamed', false],
      ['copy2.txt', 'copy.txt', 'copied', false],
      ['img.png', undefined, 'modified', true],
      ['blob.bin', undefined, 'modified', true],
    ],
  );
});

test('quoted paths are decoded, and a diff of no file or an unnamed one yields nothing', () => {
  const text = [
    'diff --git "a/caf\\303\\251 \\"q\\"\\t\\\\.txt" "b/caf\\303\\251 \\"q\\"\\t\\\\.txt"',
    'Binary files differ',
    'diff --git a/x b/y',
    '',
  ].join('\n');
  assert.deepEqual(
    parseDiff(text).map((f: any) => f.path),
    ['café "q"\t\\.txt'],
  );
  assert.deepEqual(parseDiff('not a diff\n'), []);
  assert.deepEqual(parseDiff(''), []);
  // quoted names with an escape that is not octal keep the character; a path in a rename line is decoded too
  const renamed = parseDiff('diff --git "a/x" "b/y"\nrename from "a\\u"\nrename to "b\\n"\n');
  assert.equal(renamed[0].oldPath, 'au');
  assert.equal(renamed[0].path, 'b\n');
});

test('a path with a trailing backslash, and one named without the a/ b/ prefixes', () => {
  assert.equal(parseDiff('diff --git a/p b/q\nrename from "x\\"\nrename to y\n')[0].oldPath, 'x');
  assert.equal(parseDiff('diff --git a/p b/p\n--- p\n+++ p\n')[0].path, 'p');
});

test('a path git named only in the headers and a mode-only change', () => {
  const [f] = parseDiff('diff --git a/bin/run b/bin/run\nold mode 100644\nnew mode 100755\n');
  assert.deepEqual([f.path, f.status, f.rows], ['bin/run', 'modified', []]);
});

test('word marks: the changed range of paired removed and added lines, after the common prefix and suffix', () => {
  const [f] = parseDiff(MODIFIED);
  const rows = withWordMarks(f.rows);
  assert.deepEqual(rows[2].w, [22, 23]);
  assert.deepEqual(rows[3].w, [22, 23]);
  assert.equal(rows[1].w, undefined);
  // an unpaired removal, extra additions and identical lines get no marks
  const lines = withWordMarks([
    { k: 'del', t: 'a' },
    { k: 'del', t: 'same' },
    { k: 'add', t: 'b' },
    { k: 'add', t: 'same' },
    { k: 'add', t: 'extra' },
    { k: 'ctx', t: 'x' },
    { k: 'del', t: 'lonely' },
    { k: 'ctx', t: 'y' },
  ]);
  assert.deepEqual(
    lines.map((r: any) => r.w),
    [[0, 1], undefined, [0, 1], undefined, undefined, undefined, undefined, undefined],
  );
  // a pure insertion marks only the added side
  const [ins] = [
    withWordMarks([
      { k: 'del', t: 'ab' },
      { k: 'add', t: 'aXb' },
    ]),
  ];
  assert.deepEqual([ins[0].w, ins[1].w], [undefined, [1, 2]]);
});

test('a page of rows: from, count, next and total; long lines are cut and marked', () => {
  const rows = Array.from({ length: 10 }, (_v, i) => ({ k: 'ctx', t: `l${i}` }));
  const first = pageOf(rows, 0, 4);
  assert.deepEqual([first.rows.length, first.from, first.next, first.total], [4, 0, 4, 10]);
  const last = pageOf(rows, 8, 4);
  assert.deepEqual([last.rows.length, last.next], [2, null]);
  assert.deepEqual(pageOf(rows, 99, 4).rows, []);
  const long = pageOf(
    [
      { k: 'add', t: 'x'.repeat(MAX_LINE + 50), w: [10, MAX_LINE + 40] },
      { k: 'add', t: 'y'.repeat(MAX_LINE + 1), w: [MAX_LINE + 5, MAX_LINE + 9] },
    ],
    0,
    5,
  );
  assert.equal(long.rows[0].t.length, MAX_LINE);
  assert.equal(long.rows[0].cut, true);
  assert.deepEqual(long.rows[0].w, [10, MAX_LINE]);
  assert.equal(long.rows[1].w, undefined);
});

test('a page stops at its character budget, always carrying at least one row', () => {
  const big = { k: 'ctx', t: 'z'.repeat(MAX_LINE) };
  const rows = Array.from({ length: Math.ceil(MAX_PAGE_CHARS / MAX_LINE) + 5 }, () => big);
  const page = pageOf(rows, 0, 10_000);
  assert.ok(page.rows.length <= MAX_PAGE_CHARS / MAX_LINE);
  assert.equal(page.next, page.rows.length);
  assert.equal(pageOf([big], 0, 1).rows.length, 1);
});
