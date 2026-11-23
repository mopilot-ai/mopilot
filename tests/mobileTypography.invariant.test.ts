// The phone draws all text from mobile/src/typography.ts: no raw fontSize, lineHeight or fontWeight literal anywhere else, and the scale stays on Apple's text-style sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, '..', 'mobile', 'src');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && e.name !== 'typography.ts' ? [p] : [];
  });

// a numeric size, a numeric line height, a quoted weight; computed values (`fontSize: size`, a pinch-zoomed terminal) are not literals
const RAW = /\b(?:fontSize|lineHeight)\s*:\s*-?\d|\bfontWeight\s*:\s*['"]\d|\bletterSpacing\s*:\s*-?\d/;

test('no file under mobile/src writes a raw font size, line height, weight or tracking', () => {
  const found: string[] = [];
  for (const file of sources(src)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (RAW.test(line)) found.push(`${path.relative(src, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, [], 'use ...typo.<token> from typography.ts instead');
});

test('the scale uses only Apple text-style sizes and never leads tighter than the size', async () => {
  const { typoScale, typo, typoHeading } = await import('../mobile/src/typography.ts');
  const sizes = Object.values(typoScale).map((s) => s.fontSize);
  for (const s of sizes) assert.ok([11, 12, 13, 15, 16, 17, 20, 22, 28, 34].includes(s), `${s} is not a text-style size`);
  for (const [name, s] of Object.entries(typoScale)) assert.ok(s.lineHeight >= s.fontSize * 1.1, `${name} leads too tight`);
  // every variant of a token keeps its size and line height and changes only the weight
  for (const name of Object.keys(typoScale) as (keyof typeof typoScale)[]) {
    for (const suffix of ['', 'Medium', 'Semibold', 'Bold'] as const) {
      const v = typo[`${name}${suffix}` as keyof typeof typo];
      assert.equal(v.fontSize, typoScale[name].fontSize);
      assert.equal(v.lineHeight, typoScale[name].lineHeight);
    }
  }
  assert.equal(typo.bodySemibold.fontWeight, '600');
  assert.equal(typo.body.fontWeight, '400');
  // no token turns off the system scaling or sets tracking on top of SF's own
  for (const v of Object.values(typo)) assert.equal(v.letterSpacing, undefined);
  for (let d = 1; d <= 6; d++) assert.ok(typoHeading[d].fontSize! >= 15, `heading ${d} stays readable`);
});
