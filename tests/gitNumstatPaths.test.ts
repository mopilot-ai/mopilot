// Git numstat parsing preserves literal tabs and rename record boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseNumstatZ } = createRequire(import.meta.url)('../electron/platform/gitParse.cjs');

test('tracked numstat paths retain tabs, including leading tabs and newline characters', () => {
  for (const path of ['tab\tname.txt', '\tleading.txt', 'several\ttabs\there', 'line\nbreak.txt']) {
    const stats = parseNumstatZ(`3\t1\t${path}\0`);
    assert.deepEqual(stats[path], { added: 3, removed: 1 });
    assert.deepEqual(Object.keys(stats), [path]);
  }
});

test('rename records with tabbed names do not consume the following file record', () => {
  const stats = parseNumstatZ('2\t1\t\0old\tname.txt\0new\tname.txt\0' + '4\t0\tlast\tfile.txt\0');
  assert.deepEqual(Object.keys(stats), ['new\tname.txt', 'last\tfile.txt']);
  assert.deepEqual(stats['new\tname.txt'], { added: 2, removed: 1 });
  assert.deepEqual(stats['last\tfile.txt'], { added: 4, removed: 0 });
});

test('binary counts, malformed records, and incomplete renames preserve valid following files', () => {
  const stats = parseNumstatZ('-\t-\timage\tname.bin\0' + 'invalid\0' + '0\t0\t\0old\0\0' + '1\t0\tlast.txt\0');
  assert.deepEqual(stats, { 'image\tname.bin': { added: 0, removed: 0 }, 'last.txt': { added: 1, removed: 0 } });
  assert.deepEqual(parseNumstatZ('1\t1\t\0old'), {});
  assert.deepEqual(parseNumstatZ(undefined), {});
});
