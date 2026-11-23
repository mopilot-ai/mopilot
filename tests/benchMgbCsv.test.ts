// bench/lib/mgb/files.mjs (#1381): the CSV spreadsheets the F4 tasks seed in their folder and grade from it (Numbers
// needs the App Store, which a benchmark VM cannot sign in to).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { csvRows, toCsv } = await import('../bench/lib/mgb/files.mjs');

test('toCsv quotes cells with commas, quotes or line breaks, and writes empty cells for missing ones', () => {
  assert.equal(toCsv([['a', 'b,c', null], ['"q"', 'x\ny', 'r\rs'], []]), 'a,"b,c",\n"""q""","x\ny","r\rs"\n\n');
});

test('csvRows reads back what toCsv wrote, and what editors save', () => {
  const rows = [
    ['Trip', 'Nights', 'Hotel'],
    ['Porto, May', '3', '$540'],
    ['say "hi"', '', 'two\nlines'],
    [],
    ['How to fill', 'Hotel = nights x rate'],
  ];
  assert.deepEqual(csvRows(toCsv(rows)), [...rows.slice(0, 3), [''], rows[4]]);
  // CRLF endings, a byte-order mark and no final line break
  assert.deepEqual(csvRows('﻿a,b\r\n1,"2\r\n3"'), [
    ['a', 'b'],
    ['1', '2\r\n3'],
  ]);
  // a European export separated by semicolons
  assert.deepEqual(csvRows('Trip;Total\nPorto;"1,5"\n'), [
    ['Trip', 'Total'],
    ['Porto', '1,5'],
  ]);
  // a header with both keeps commas as the separator
  assert.deepEqual(csvRows('a;b,c\n'), [['a;b', 'c']]);
  // a trailing empty cell is kept; nothing at all is no rows
  assert.deepEqual(csvRows('x,\n'), [['x', '']]);
  assert.deepEqual(csvRows(''), []);
  assert.deepEqual(csvRows(undefined), []);
});
