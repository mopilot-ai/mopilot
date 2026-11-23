// Quoted CSV/TSV parsing and sheet limits protect rich tables without treating cell strings as markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedSheet, delimitedSheet, PREVIEW_ROWS, PREVIEW_COLUMNS } from '../src/lib/previewTables.ts';

test('CSV preserves quoting, embedded separators/newlines, escapes, BOM and empty cells', () => {
  assert.deepEqual(delimitedSheet('\uFEFFname,value\r\n"one,two","line\nnext"\r\n"a""b",\r\nplain"quote,last', ',').rows, [
    ['name', 'value'],
    ['one,two', 'line\nnext'],
    ['a"b', ''],
    ['plain"quote', 'last'],
  ]);
  assert.deepEqual(delimitedSheet('x\ty\rz\t"a\tb"\n', '\t').rows, [
    ['x', 'y'],
    ['z', 'a\tb'],
  ]);
  assert.deepEqual(delimitedSheet('a,b,', ',').rows, [['a', 'b', '']]);
  assert.deepEqual(delimitedSheet('', ',').rows, []);
  assert.throws(() => delimitedSheet('"unfinished', ','), /incomplete/);
});

test('large sheets and CSV are bounded, with an explicit truncation signal', () => {
  const rows = Array.from({ length: PREVIEW_ROWS + 1 }, () => ['x']);
  assert.equal(boundedSheet('Rows', rows).rows.length, PREVIEW_ROWS);
  assert.equal(boundedSheet('Rows', rows).truncated, true);
  assert.equal(delimitedSheet(rows.map((r) => r[0]).join('\n'), ',').truncated, true);
  assert.equal(
    delimitedSheet(
      Array(PREVIEW_ROWS + 2)
        .fill('x')
        .join('\n'),
      ',',
    ).truncated,
    true,
  );
  const wide = boundedSheet('Columns', [Array(PREVIEW_COLUMNS + 1).fill('x')]);
  assert.equal(wide.rows[0].length, PREVIEW_COLUMNS);
  assert.equal(wide.truncated, true);
  assert.deepEqual(boundedSheet('Values', [[null, undefined, 1, false, '<script>']]), {
    name: 'Values',
    rows: [['', '', '1', 'false', '<script>']],
    truncated: false,
  });
});
