// Lazy PDF setup uses a bundled worker and refuses document creation after its owner is cancelled.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import './support/dom.ts';
registerHooks({
  load(url, context, next) {
    return url.endsWith('/pdf.worker.min.mjs?url')
      ? { format: 'module', source: 'export default "bundled-pdf-worker.js"', shortCircuit: true }
      : next(url, context);
  },
});
const options: unknown[] = [];
const GlobalWorkerOptions = { workerSrc: '' };
const task = { promise: Promise.resolve({}), destroy: async () => {} };
mock.module('pdfjs-dist', {
  namedExports: {
    GlobalWorkerOptions,
    getDocument: (value: unknown) => {
      options.push(value);
      return task;
    },
  },
});
const { openPreviewPdf } = await import('../src/lib/previewPdf.ts');

test('PDF opens copied bytes with local worker setup, leaving the original read usable', async () => {
  const data = new Uint8Array([1, 2]);
  assert.equal(await openPreviewPdf(data, new AbortController().signal), task);
  const params = options[0] as any;
  assert.deepEqual(params.data, data);
  assert.notEqual(params.data, data);
  assert.equal(params.useSystemFonts, true);
  assert.equal(params.cMapPacked, true);
  assert.equal(params.cMapUrl, 'http://localhost/preview/pdf/cmaps/');
  assert.equal(params.wasmUrl, 'http://localhost/preview/pdf/wasm/');
  assert.equal(params.standardFontDataUrl, 'http://localhost/preview/pdf/standard_fonts/');
  assert.equal(params.iccUrl, 'http://localhost/preview/pdf/iccs/');
  assert.equal(params.useWorkerFetch, undefined, 'PDF.js must choose its file-compatible XHR resource path for packaged pages');
  assert.equal(GlobalWorkerOptions.workerSrc, 'bundled-pdf-worker.js');
});

test('an owner cancelled during lazy loading never creates a PDF worker/document task', async () => {
  const controller = new AbortController();
  const pending = openPreviewPdf(new Uint8Array([1]), controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(options.length, 1);
});
