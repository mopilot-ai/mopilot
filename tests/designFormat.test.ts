// The design-system file format (shared/designSystem.mjs): @dsCard markers in any quoting, a manifest in a stable order,
// tokens in DTCG or flat form, design.json checks that name each problem, and folder-relative paths only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDsCard,
  compileManifest,
  nameFromPath,
  readmeTitle,
  slugOf,
  flattenTokens,
  summarizeTokens,
  checkDesignIndex,
  isRelativeInside,
  naturalCompare,
} from '../shared/designSystem.mjs';

test('parseDsCard: the first line, with a BOM, CRLF, either quote, extra attributes and a viewport', () => {
  assert.deepEqual(parseDsCard('﻿<!-- @dsCard group="Buttons" name="Primary" viewport="480x200" -->\r\n<div></div>'), {
    group: 'Buttons',
    name: 'Primary',
    viewport: { width: 480, height: 200 },
  });
  assert.deepEqual(parseDsCard("  \n<!--@dsCard group='Type' data-x='1' viewport='640'-->"), {
    group: 'Type',
    name: null,
    viewport: { width: 640, height: null },
  });
  assert.deepEqual(parseDsCard('<!-- @dsCard GROUP="Colors" viewport="wide" -->'), { group: 'Colors', name: null, viewport: null });
  // a marker without a group still parses, so the checker can name it
  assert.deepEqual(parseDsCard('<!-- @dsCard name="x" -->'), { group: '', name: 'x', viewport: null });
  assert.equal(parseDsCard('<html><!-- @dsCard group="late" -->'), null);
  assert.equal(parseDsCard(''), null);
  assert.equal(parseDsCard(undefined as any), null);
});

test('compileManifest: grouped and naturally ordered whatever order the cards came in; cards without a group are left out', () => {
  const cards = [
    { path: 'preview/b/slide-10.html', group: 'B', name: null },
    { path: 'preview/a/x.html', group: 'a', name: 'X', viewport: { width: 10, height: null } },
    { path: 'preview/b/slide-2.html', group: 'B' },
    { path: 'preview/none.html', group: '' },
  ];
  const m = compileManifest(cards);
  assert.deepEqual(m, {
    v: 1,
    cards: [
      { path: 'preview/a/x.html', group: 'a', name: 'X', viewport: { width: 10, height: null } },
      { path: 'preview/b/slide-2.html', group: 'B', name: 'Slide 2' },
      { path: 'preview/b/slide-10.html', group: 'B', name: 'Slide 10' },
    ],
  });
  assert.deepEqual(compileManifest([...cards].reverse()), m);
  assert.equal(naturalCompare('A', 'a') !== 0, true, 'case still gives a stable order');
  assert.equal(naturalCompare('same', 'same'), 0);
  assert.equal(naturalCompare('a', 'A'), 1);
});

test('names: a card from its file, the README title, and a folder slug', () => {
  assert.equal(nameFromPath('preview/buttons/primary-button.html'), 'Primary button');
  assert.equal(nameFromPath('---.html'), '---.html');
  assert.equal(readmeTitle('﻿intro\n#  Acme DS ##\nmore'), 'Acme DS');
  assert.equal(readmeTitle('## not a title'), null);
  assert.equal(readmeTitle(undefined as any), null);
  assert.equal(slugOf('Café Design / v2!'), 'cafe-design-v2');
  assert.equal(slugOf('***'), 'design-system');
  assert.equal(slugOf(undefined as any), 'design-system');
  assert.equal(slugOf(`${'a'.repeat(63)} b`), 'a'.repeat(63));
});

test('tokens: DTCG groups inherit $type, flat maps work, and junk gives none', () => {
  const dtcg = {
    color: { $type: 'color', accent: { $value: '#c6613f' }, ink: { $value: 'oklch(0.2 0 0)' } },
    font: { family: { body: { $value: 'Inter, sans-serif', $type: 'fontFamily' } } },
    space: { sm: { $value: '4px' } },
    shadow: { md: { $value: { x: 0, y: 2 }, $type: 'shadow' } },
    $description: 'ignored',
  };
  assert.deepEqual(flattenTokens(dtcg), [
    { name: 'color.accent', value: '#c6613f', type: 'color' },
    { name: 'color.ink', value: 'oklch(0.2 0 0)', type: 'color' },
    { name: 'font.family.body', value: 'Inter, sans-serif', type: 'fontFamily' },
    { name: 'space.sm', value: '4px', type: null },
    { name: 'shadow.md', value: '{"x":0,"y":2}', type: 'shadow' },
  ]);
  const s = summarizeTokens({ '--bg': '#fff', 'fonts.mono': 'SF Mono', size: 14, 'line-height': '1.4', weight: 'bold', flag: true });
  assert.deepEqual(s.colors, [{ name: '--bg', value: '#fff' }]);
  assert.deepEqual(s.fonts, [{ name: 'fonts.mono', value: 'SF Mono' }]);
  assert.deepEqual(s.sizes, []);
  assert.equal(s.other, 3);
  assert.equal(s.total, 5, 'a boolean is not a token');
  const d = summarizeTokens(dtcg);
  assert.deepEqual([d.colors.length, d.fonts.length, d.sizes.length, d.other], [2, 1, 1, 1]);
  assert.deepEqual(summarizeTokens({ s: { $value: '1rem', $type: 'dimension' }, f: { $value: '12', $type: 'fontSize' } }).sizes.length, 2);
  for (const junk of [null, 'x', [1, 2], 3]) assert.deepEqual(flattenTokens(junk), []);
  // a cycle-free but very deep or very wide file stops at the bounds
  let deep: any = { $value: 'x' };
  for (let i = 0; i < 20; i += 1) deep = { a: deep };
  assert.deepEqual(flattenTokens(deep), []);
  const wide = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`t${i}`, i]));
  assert.equal(flattenTokens(wide).length, 5000);
});

test('checkDesignIndex: each problem in words; a good index has none', () => {
  assert.deepEqual(
    checkDesignIndex({
      v: 1,
      type: 'slides',
      title: 'Deck',
      pages: ['slides/01.html'],
      size: { width: 1920, height: 1080 },
      designSystems: [{ path: 'design-systems/acme' }],
      extra: 1,
    }),
    [],
  );
  assert.deepEqual(checkDesignIndex([]), ['design.json is not a JSON object.']);
  assert.deepEqual(checkDesignIndex(null), ['design.json is not a JSON object.']);
  const bad = checkDesignIndex({ type: 'poster', title: ' ', pages: ['../x.html', 'a.png'], designSystems: 'acme', size: { width: 0 } });
  assert.equal(bad.length, 6);
  assert.match(bad.join('\n'), /"type" must be/);
  assert.match(bad.join('\n'), /no "title"/);
  assert.match(bad.join('\n'), /"\.\.\/x\.html" is not a relative/);
  assert.match(bad.join('\n'), /"a\.png"/);
  assert.match(bad.join('\n'), /"designSystems" must be a list/);
  assert.match(bad.join('\n'), /"size" must be/);
  assert.match(checkDesignIndex({ type: 'design', title: 'x', pages: [] }).join(), /at least one page/);
  assert.match(
    checkDesignIndex({ type: 'design', title: 'x', pages: ['i.html'], designSystems: [null, { path: 3 }] }).join('\n'),
    /needs a "path"/,
  );
  assert.match(checkDesignIndex({ type: 'design', title: 'x', pages: ['i.html'], size: null }).join(), /"size"/);
});

test('isRelativeInside: only folder-relative paths', () => {
  for (const ok of ['a.html', 'preview/x/y.html', './a.md', '..notes.md']) assert.equal(isRelativeInside(ok), true, ok);
  for (const no of ['', '/etc/passwd', 'C:x', 'a\\b', '../a', 'a/../b', 'a//b', 'a/', 'x\0', 'x'.repeat(513), 7, null])
    assert.equal(isRelativeInside(no), false, String(no));
});
