// Real PDF/Office fixture decoding verifies local CMap/WASM assets and catches malformed synthetic files before app checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writePreviewFiles } from './fixtures/previewFiles.ts';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pptx from '@office-kit/pptx';
import { renderSlideToSvg } from '@office-kit/pptx-preview';
import { copyPdfAssets } from '../scripts/pdf-assets.mjs';

test('synthetic PDFs decode pages, external CJK mappings and JPEG2000 pixels using shipped resources', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-fixtures-'));
  try {
    await writePreviewFiles(folder);
    copyPdfAssets(folder);
    const resources = path.join(folder, 'preview/pdf');
    for (const file of ['document.pdf', 'cjk.pdf', 'jpeg2000.pdf']) {
      const task = getDocument({
        data: new Uint8Array(fs.readFileSync(path.join(folder, file))),
        useSystemFonts: true,
        cMapUrl: path.join(resources, 'cmaps') + '/',
        cMapPacked: true,
        wasmUrl: path.join(resources, 'wasm') + '/',
        standardFontDataUrl: path.join(resources, 'standard_fonts') + '/',
      });
      try {
        const document = await task.promise;
        assert.equal(document.numPages, file === 'document.pdf' ? 2 : 1);
        const page = await document.getPage(1);
        if (file === 'jpeg2000.pdf') assert.ok((await page.getOperatorList()).fnArray.includes(OPS.paintImageXObject));
        else
          assert.match(
            (await page.getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(''),
            file === 'cjk.pdf' ? /東京/ : /First PDF page/,
          );
      } finally {
        await task.destroy();
      }
    }
    const presentation = await pptx.loadPresentation(fs.readFileSync(path.join(folder, 'slides.pptx')));
    assert.equal(pptx.getSlides(presentation).length, 2);
    assert.match(renderSlideToSvg(presentation, pptx.getSlides(presentation)[1]), /Second preview slide/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the shared preview fixture loads and writes files through Playwright CommonJS compilation', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-playwright-'));
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
      const { requireOrImport } = require('playwright/lib/common').transform;
      requireOrImport(process.argv[1]).then(({ writePreviewFiles }) => writePreviewFiles(process.argv[2])).catch(error => {
        console.error(error); process.exitCode = 1;
      });
    `,
        path.resolve('tests/fixtures/previewFiles.ts'),
        folder,
      ],
      { timeout: 30_000, stdio: 'pipe' },
    );
    assert.ok(fs.readFileSync(path.join(folder, 'document.pdf')).length > 0);
    assert.ok(fs.readFileSync(path.join(folder, 'legacy-word.doc')).length > 0);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
