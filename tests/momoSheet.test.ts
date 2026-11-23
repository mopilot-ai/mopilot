// MoMo's spreadsheets (#2139 Outputs, electron/momo/xlsx.cjs and momo_save_sheet in outputsTools.cjs): the .xlsx main builds from rows is a real workbook (read back with SheetJS), every string is text and never a formula, limits and odd characters are handled, momo_save_file cannot make an .xlsx from text, and a saved sheet is audited and listed like any file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { store, rig } from './support/momo-outputs-rig.ts';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { buildXlsx, SheetError, sheetName, MAX_ROWS, MAX_COLS, MAX_CELL, MAX_CELLS, MAX_CHARS } = require('../electron/momo/xlsx.cjs');
const { MAX_FILE } = require('../electron/momo/outputs.cjs');

const read = (buf: Buffer) => XLSX.read(buf, { type: 'buffer' });

test('the workbook opens: cells keep their types, text starting with = + - @ stays text without a formula, empty cells are empty', () => {
  const buf = buildXlsx(
    [
      ['name', 'qty', 'ok'],
      ['=HYPERLINK("http://evil.test","x")', 3.5, true],
      ['+1 @a -b', null, false],
      ['  padded  ', '', 'a & b <c> "d"'],
    ],
    'Budget',
  );
  assert.deepEqual(buf.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const wb = read(buf);
  assert.deepEqual(wb.SheetNames, ['Budget']);
  const ws = wb.Sheets.Budget;
  assert.deepEqual([ws.A2.t, ws.A2.v, ws.A2.f], ['s', '=HYPERLINK("http://evil.test","x")', undefined]);
  assert.deepEqual([ws.B2.t, ws.B2.v], ['n', 3.5]);
  assert.deepEqual([ws.C2.t, ws.C2.v, ws.C3.v], ['b', true, false]);
  assert.equal(ws.A3.v, '+1 @a -b');
  assert.equal(ws.B3, undefined);
  assert.equal(ws.B4, undefined);
  assert.equal(ws.A4.v, '  padded  ');
  assert.equal(ws.C4.v, 'a & b <c> "d"');
  for (const cell of Object.keys(ws).filter((k) => !k.startsWith('!'))) assert.equal(ws[cell].f, undefined, `${cell} has no formula`);
  assert.deepEqual(buildXlsx([['x']]), buildXlsx([['x']]), 'the same rows give the same bytes');
  // a wide sheet names its columns past Z
  const wide = read(buildXlsx([Array.from({ length: 30 }, (_, i) => i)])).Sheets.Sheet1;
  assert.equal(wide.AA1.v, 26);
});

test('characters XML cannot carry are dropped, the sheet name is made valid, and limits say what to fix', () => {
  const ws = read(buildXlsx([['a\u0000b\u0007c\ud800d', 'ok\u{1f600}']], 'Q1: [plan]/*?\\')).Sheets;
  assert.deepEqual(Object.keys(ws), ['Q1   plan']);
  assert.equal(ws['Q1   plan'].A1.v, 'abcd');
  assert.equal(ws['Q1   plan'].B1.v, 'ok\u{1f600}');
  assert.equal(sheetName(undefined), 'Sheet1');
  assert.equal(sheetName('[]:'), 'Sheet1');
  assert.equal(sheetName('x'.repeat(40)).length, 31);
  const bad = (rows: unknown, re: RegExp) =>
    assert.throws(
      () => buildXlsx(rows),
      (e: any) => e instanceof SheetError && e.code === 'bad_rows' && re.test(e.message),
    );
  bad(undefined, /non-empty array/);
  bad([], /non-empty array/);
  bad('x', /non-empty array/);
  bad(['a'], /Row 1 must be an array/);
  bad(
    Array.from({ length: MAX_ROWS + 1 }, () => ['x']),
    /At most 5000 rows/,
  );
  bad([Array.from({ length: MAX_COLS + 1 }, () => 'x')], /At most 100 columns/);
  bad([['x'.repeat(MAX_CELL + 1)]], /longer than 5000 characters \(row 1, column 1\)/);
  bad([['ok', { a: 1 }]], /row 1, column 2 must be/);
  bad([[Number.NaN]], /row 1, column 1 must be/);
  bad([[Number.POSITIVE_INFINITY]], /row 1, column 1 must be/);
});

test('the store takes built bytes only as an xlsx; text cannot become an xlsx; the cap applies', () => {
  const { s } = store();
  const code = (a: object) => {
    try {
      s.prepare(a);
    } catch (e) {
      return (e as any).code;
    }
  };
  const bytes = buildXlsx([['x']]);
  assert.equal(code({ name: 'a.xlsx', bytes }), undefined);
  assert.equal(code({ name: 'a.csv', bytes }), 'bad_content');
  assert.equal(code({ name: 'a.xlsx', bytes: 'text' }), 'bad_content');
  assert.equal(code({ name: 'a.xlsx', content: 'PK\u0003\u0004' }), 'bad_type');
  assert.equal(code({ name: 'a.xlsx', bytes: Buffer.alloc(MAX_FILE + 1) }), 'too_large');
});

test('momo_save_sheet: saved with no card and a real workbook on disk, .xlsx added to a bare name, audited, listed; bad rows are told to MoMo', async () => {
  const r = rig();
  const text = await r.run('momo_save_sheet', {
    name: 'budget',
    rows: [
      ['item', 'cost'],
      ['=SUM(A1)', 12],
    ],
    sheet: 'Plan',
    note: 'november budget',
  });
  assert.match(text, /^Saved budget\.xlsx \(\d+(\.\d)? KB\) in the user's Outputs list/);
  assert.equal(r.cards.length, 0);
  const file = path.join(r.dir, 'outputs', 'budget.xlsx');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(read(fs.readFileSync(file)).Sheets.Plan.A2.v, '=SUM(A1)');
  assert.deepEqual(
    r.entries().map((e: any) => [e.kind, e.kind === 'intent' ? e.action : e.result]),
    [
      ['intent', 'momo_save_sheet'],
      ['outcome', 'done'],
    ],
  );
  assert.match(String(await r.run('momo_outputs_list', {})), /^budget\.xlsx · .* · november budget$/);
  // a name with its own type keeps it (and a wrong one is refused); a second save is numbered
  assert.match(await r.run('momo_save_sheet', { name: 'budget.xlsx', rows: [['x']] }), /budget \(2\)\.xlsx/);
  // a name that is not an .xlsx ends in .xlsx whatever it carries: a text type is replaced, any other dot is kept
  assert.match(await r.run('momo_save_sheet', { name: 'report.csv', rows: [['x']] }), /^Saved report\.xlsx/);
  assert.match(await r.run('momo_save_sheet', { name: ' budget.v2 ', rows: [['x']] }), /^Saved budget\.v2\.xlsx/);
  assert.match(await r.run('momo_save_sheet', { name: 'old.XLS', rows: [['x']] }), /^Saved old\.xlsx/);
  await assert.rejects(r.run('momo_save_sheet', { name: 'x', rows: [] }), (e: any) => e.code === 'bad_rows');
  await assert.rejects(r.run('momo_save_sheet', { name: '../x', rows: [['x']] }), (e: any) => e.code === 'bad_name');
  await assert.rejects(r.run('momo_save_sheet', undefined), (e: any) => e.code === 'bad_rows');
  await assert.rejects(
    r.run('momo_save_file', { name: 'fake.xlsx', content: 'PK' }),
    (e: any) => e.code === 'bad_type' && /call momo_save_sheet with rows/.test(e.message),
  );
  await assert.rejects(r.run('momo_save_sheet', { rows: [['x']] }), (e: any) => e.code === 'bad_name');
  // a failure that is not a sheet error is not mistaken for one
  const odd = {
    get rows(): unknown {
      throw new Error('boom');
    },
  };
  await assert.rejects(r.run('momo_save_sheet', odd), /boom/);
});

test('a failure of the checks themselves is not mistaken for a refusal', async () => {
  const r = rig();
  r.s.prepare = () => {
    throw new Error('prep');
  };
  await assert.rejects(r.run('momo_save_file', { name: 'a.md', content: 'x' }), /prep/);
});

test('names SheetJS refuses are made valid, and anything else it refuses reaches the model as a coded error', () => {
  assert.equal(sheetName("'quoted'"), 'quoted');
  assert.equal(sheetName("  ''  "), 'Sheet1');
  assert.equal(sheetName('History'), 'History 1');
  assert.equal(sheetName(' history '), 'history 1');
  for (const name of ["'a", "a'", 'History', 'HISTORY']) assert.deepEqual(read(buildXlsx([['x']], name)).SheetNames.length, 1, name);
  const orig = XLSX.write;
  XLSX.write = () => {
    throw new Error('internal failure of the library');
  };
  try {
    assert.throws(
      () => buildXlsx([['x']]),
      (e: any) => e instanceof SheetError && e.code === 'bad_rows' && /could not be built \(internal failure/.test(e.message),
    );
    XLSX.write = () => {
      throw 'not an error object';
    };
    assert.throws(
      () => buildXlsx([['x']]),
      (e: any) => e instanceof SheetError && /could not be built \(not an error object\)/.test(e.message),
    );
  } finally {
    XLSX.write = orig;
  }
});

test('the build is bounded before it starts (500,000 cells took 3.7 s): cells and text in all, and the largest allowed sheet builds quickly', () => {
  const bad = (rows: unknown, re: RegExp) =>
    assert.throws(
      () => buildXlsx(rows),
      (e: any) => e instanceof SheetError && re.test(e.message),
    );
  bad(
    Array.from({ length: MAX_CELLS / 100 + 1 }, () => Array.from({ length: 100 }, () => 'x')),
    /At most 20000 cells in all.*momo_save_file/,
  );
  const long = 'x'.repeat(MAX_CELL);
  bad(
    Array.from({ length: MAX_CHARS / MAX_CELL + 1 }, () => [long]),
    /At most 500000 characters of text in all/,
  );
  const started = Date.now();
  const full = buildXlsx(Array.from({ length: MAX_CELLS / 100 }, (_, r) => Array.from({ length: 100 }, (_, c) => `cell ${r}-${c}`)));
  assert.ok(Date.now() - started < 2000, 'the largest allowed sheet builds in well under two seconds');
  assert.equal(read(full).Sheets.Sheet1.CV200.v, 'cell 199-99');
});

test('the flag going off while a sheet waits refuses it inside the gate: no file', async () => {
  const flag = { on: true };
  const r = rig({ flag, before: () => void (flag.on = false) });
  await assert.rejects(r.run('momo_save_sheet', { name: 'late', rows: [['x']] }), (e: any) => e.code === 'off');
  assert.equal(fs.existsSync(path.join(r.dir, 'outputs')), false);
});
