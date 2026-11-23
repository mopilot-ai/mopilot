// Feature-owned component metadata carries renderer dependency licenses and additional resource notices into the shipped file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { thirdPartyFeatures, featureNoticeTexts } from '../scripts/third-party-features.mjs';
import { buildNotices, build } from '../scripts/gen-third-party.mjs';

test('feature files are discovered deterministically without a shared registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-features-'));
  try {
    assert.deepEqual(thirdPartyFeatures(root), []);
    fs.writeFileSync(path.join(root, 'b.json'), '{"name":"B"}');
    fs.writeFileSync(path.join(root, 'a.json'), '{"name":"A"}');
    fs.writeFileSync(path.join(root, 'README.md'), 'not metadata');
    assert.deepEqual(
      thirdPartyFeatures(root).map((entry) => entry.name),
      ['A', 'B'],
    );
    fs.writeFileSync(path.join(root, 'license'), 'Real license \r\nSecond line\t\n');
    assert.match(featureNoticeTexts(root, [{ title: 'Example', path: 'license' }])[0], /Real license/);
    assert.doesNotMatch(featureNoticeTexts(root, [{ title: 'Example', path: 'license' }])[0], /\r|[ \t]+$/m);
    assert.throws(() => featureNoticeTexts(root, [{ title: 'Missing', path: 'absent' }]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shipped preview decoders and their third-party resource notices cannot disappear', () => {
  const text = buildNotices();
  for (const name of [
    'pdfjs-dist',
    'docx-preview',
    '@office-kit/pptx',
    '@office-kit/pptx-preview',
    'xlsx',
    'cfb',
    'word-extractor',
    'jszip',
  ])
    assert.ok(
      build().direct.some((entry) => entry.name === name),
      name,
    );
  for (const title of [
    'PDF.js CMaps',
    'PDF.js Foxit fonts',
    'PDF.js Liberation fonts',
    'PDF.js ICC profiles',
    'JBIG2 decoder',
    'OpenJPEG decoder',
    'PowerPoint parser third-party notices',
    'Legacy Word reader',
    'JSZip',
  ])
    assert.ok(text.includes(`#### ${title}`), title);
  assert.match(text, /Apache License/);
  assert.ok(thirdPartyFeatures().length > 0);
});
