// Office decoder boundaries retain cancellation, local markup isolation and real XLS/XLSX worksheet contents.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import * as xlsx from 'xlsx';
import JSZip from 'jszip';

let renderGate: Promise<void> | null = null;
let presentationGate: Promise<any> | null = null;
let slides: unknown[] = [{}];
let renders = 0;
mock.module('docx-preview', {
  namedExports: {
    renderAsync: async (_bytes: unknown, body: HTMLElement, styles: HTMLElement, options: any) => {
      assert.equal(options.useBase64URL, true);
      assert.equal(options.renderAltChunks, false);
      assert.equal(options.ignoreFonts, true);
      if (renderGate) await renderGate;
      body.innerHTML = '<section class="docx">Document body</section>';
      styles.innerHTML = '<style>.docx{color:red}</style>';
    },
  },
});
mock.module('@office-kit/pptx', {
  namedExports: { loadPresentation: async () => (presentationGate ? await presentationGate : {}), getSlides: () => slides },
});
mock.module('@office-kit/pptx-preview', {
  namedExports: {
    renderSlideToSvg: () => {
      renders++;
      return '<svg><text>Slide text</text></svg>';
    },
  },
});
const { decodeOffice, officePreviewDocument, checkPreviewActive } = await import('../src/lib/previewOffice.ts');
const input = { kind: 'binary' as const, data: new Uint8Array([1, 2]) };
const owner = () => new AbortController();

test('legacy document text remains explicitly typed; cancelled inputs never start decoders', async () => {
  assert.deepEqual(await decodeOffice('/file.doc', { kind: 'text', text: 'Legacy' }, owner().signal), { kind: 'text', text: 'Legacy' });
  const aborted = owner();
  aborted.abort();
  assert.throws(() => checkPreviewActive(aborted.signal));
  await assert.rejects(decodeOffice('/file.docx', input, aborted.signal));
  const pending = owner(),
    result = decodeOffice('/file.xlsx', input, pending.signal);
  pending.abort();
  await assert.rejects(result);
});

test('real XLS and XLSX bytes preserve sheet names, formatted values, empty cells and multiple sheets', async () => {
  for (const bookType of ['xlsx', 'biff8'] as const) {
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      book,
      xlsx.utils.aoa_to_sheet([
        ['Name', 'Value'],
        ['封面 <script>', 42],
        ['Empty', null],
      ]),
      'First',
    );
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['Other sheet']]), 'Second');
    const data = new Uint8Array(xlsx.write(book, { type: 'buffer', bookType }));
    const result = await decodeOffice(bookType === 'xlsx' ? '/file.xlsx' : '/file.xls', { kind: 'binary', data }, owner().signal);
    assert.equal(result.kind, 'sheets');
    if (result.kind !== 'sheets') assert.fail('workbook');
    assert.equal(result.sheets.length, 2);
    assert.equal(result.sheets[0].name, 'First');
    assert.deepEqual(result.sheets[0].rows[1], ['封面 <script>', '42']);
    assert.deepEqual(result.sheets[0].rows[2], ['Empty', '']);
  }
});

test('a sparse workbook clips its conversion rectangle before materializing cells', async () => {
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['Visible cell']]), 'Sparse');
  const zip = await JSZip.loadAsync(xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  zip.file('xl/worksheets/sheet1.xml', xml.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:XFD1001"/>'));
  const data = await zip.generateAsync({ type: 'uint8array' });
  const real = xlsx.utils.sheet_to_json;
  const convert = mock.method(xlsx.utils, 'sheet_to_json', (sheet, options: any) => {
    assert.ok(options.range, 'conversion must be bounded before allocating the table');
    assert.ok(options.range.e.c - options.range.s.c < 100);
    assert.ok(options.range.e.r - options.range.s.r < 1000);
    return real(sheet, options);
  });
  try {
    const result = await decodeOffice('/sparse.xlsx', { kind: 'binary', data }, owner().signal);
    assert.equal(result.kind, 'sheets');
    if (result.kind !== 'sheets') assert.fail('workbook');
    assert.equal(result.sheets[0].truncated, true);
    assert.equal(result.sheets[0].rows[0][0], 'Visible cell');
  } finally {
    convert.mock.restore();
  }
});

test('empty sheets and row-limited workbooks retain their original range and an accurate truncation notice', async () => {
  for (const rows of [[], Array.from({ length: 1002 }, (_, index) => [index])]) {
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(rows), 'Sheet');
    const data = new Uint8Array(xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const result = await decodeOffice('/range.xlsx', { kind: 'binary', data }, owner().signal);
    assert.equal(result.kind, 'sheets');
    if (result.kind !== 'sheets') assert.fail('workbook');
    assert.equal(result.sheets[0].truncated, rows.length > 1000);
    assert.equal(result.sheets[0].rows.length, Math.min(rows.length, 1000));
  }
});

test('offset worksheet ranges preserve their first used rows instead of an absolute row ceiling', async () => {
  for (const bookType of ['xlsx', 'biff8'] as const)
    for (const start of [500, 2000]) {
      const book = xlsx.utils.book_new();
      const sheet: xlsx.WorkSheet = { '!ref': `A${start + 1}:B${start + 1000}` };
      for (let row = start; row < start + 1000; row++) {
        sheet[`A${row + 1}`] = { t: 's', v: `Used row ${row - start + 1}` };
        sheet[`B${row + 1}`] = { t: 'n', v: row };
      }
      xlsx.utils.book_append_sheet(book, sheet, 'Offset');
      const data = new Uint8Array(xlsx.write(book, { type: 'buffer', bookType }));
      const result = await decodeOffice('/offset.xlsx', { kind: 'binary', data }, owner().signal);
      if (result.kind !== 'sheets') assert.fail('workbook');
      assert.equal(result.sheets[0].rows.length, 1000);
      assert.equal(result.sheets[0].rows[0][0], 'Used row 1');
      assert.equal(result.sheets[0].rows[999][0], 'Used row 1000');
      assert.equal(result.sheets[0].truncated, false);
    }
});

test('Word renders in a detached document; cancellation after the render retires publication', async () => {
  const rendered = await decodeOffice('/file.docx', input, owner().signal);
  assert.equal(rendered.kind, 'html');
  if (rendered.kind !== 'html') assert.fail('Word');
  assert.match(rendered.html, /Document body/);
  assert.match(rendered.html, /<style>/);
  assert.equal(document.body.querySelector('.docx'), null);
  const gate = deferred<void>();
  renderGate = gate.promise;
  const abort = owner(),
    pending = decodeOffice('/retired.docx', input, abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  gate.resolve();
  await assert.rejects(pending);
  renderGate = null;
});

test('PowerPoint renders each slide locally and rejects empty or oversized presentations', async () => {
  slides = [{}, {}];
  renders = 0;
  const rendered = await decodeOffice('/file.pptx', input, owner().signal);
  assert.equal(rendered.kind, 'html');
  if (rendered.kind !== 'html') assert.fail('PowerPoint');
  assert.match(rendered.html, /Slide 2/);
  assert.equal(renders, 2);
  slides = [];
  await assert.rejects(decodeOffice('/empty.pptx', input, owner().signal), /no slides/);
  slides = Array(201).fill({});
  await assert.rejects(decodeOffice('/huge.pptx', input, owner().signal), /200 slides/);
  slides = [{}];
  const gate = deferred<any>();
  presentationGate = gate.promise;
  const abort = owner(),
    pending = decodeOffice('/retired.pptx', input, abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  gate.resolve({});
  await assert.rejects(pending);
  presentationGate = null;
});

test('Office markup is enclosed by a document with no scripts, remote resources, forms or base URL', () => {
  const html = officePreviewDocument('<img src="https://example.com/x"><script>parent.native()</script>');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data: blob:/);
  assert.match(html, /base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(html, /allow-scripts|script-src 'unsafe-inline'/);
});
