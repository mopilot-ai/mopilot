// An icon beside text that may wrap sits at the top of its row (align-items: flex-start), centred on the text's first
// line. That line is the row's line-height times a font size that scales with the Chat font size (Settings ->
// Appearance -> Advanced), so the icon's box is one line tall (`height: 1lh`) and centres the glyph in it; a box of
// fixed pixels, or a pixel nudge down from the top, was tuned for 14px and drifted above the text as the font grew
// (the task list's spinner and rings). An svg icon also keeps a min-height of its drawn size, since an svg in a box
// shorter than its width draws smaller. docs/bug-prevention/edge-states.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/styles/'];

const css = postcss.parse(appCss());

/** Declarations of every top-level selector, later rules winning, as the cascade resolves them. */
const DECLS = new Map<string, Record<string, string>>();
css.walkRules((r) => {
  if (r.parent?.type !== 'root') return;
  for (const s of r.selectors) {
    const out = DECLS.get(s) ?? {};
    r.walkDecls((d) => void (out[d.prop] = d.value));
    DECLS.set(s, out);
  }
});
const decls = (selector: string) => DECLS.get(selector) ?? {};

/** Each row that tops-aligns an icon beside its text, and the selector of that icon's box. */
const MARKERS: [row: string, marker: string][] = [
  ['.todo-step', '.todo-check'],
  ['.turn-error', '.turn-error > svg'],
  ['.turn-stall', '.turn-stall > svg'],
  ['.approval-risk', '.approval-risk > svg'],
  ['.approval-remote', '.approval-remote > svg'],
  ['.browser-confirm .desktop-access-warning', '.browser-confirm .desktop-access-warning > svg'],
  ['.hrow-warn', '.hrow-warn > svg'],
  ['.works-item', '.works-mark'],
  ['.menu-item.has-desc', '.menu-item.has-desc .menu-icon'],
];

test('each listed row tops-aligns its icon, and the icon box is one text line tall', () => {
  for (const [row, marker] of MARKERS) {
    assert.match(decls(row)['align-items'] ?? '', /^(flex-)?start$/, `${row} keeps its icon at the top of the row`);
    const box = decls(marker);
    assert.equal(box.height, '1lh', `${marker} is as tall as the text's first line`);
    assert.ok(!/px$/.test(box['margin-top'] ?? ''), `${marker} has no pixel nudge from the top (${box['margin-top']})`);
    // an svg narrower than its box keeps its size; a line shorter than its width (Chat font 10px) would scale it down
    if (marker.endsWith('svg') || marker === '.works-mark')
      assert.match(box['min-height'] ?? '', /^1[3-6]px$/, `${marker} keeps its drawn size`);
  }
});

test('a task step centres its marker in the line box', () => {
  const check = decls('.todo-check');
  assert.equal(check.display, 'grid');
  assert.equal(check['place-items'], 'center');
  // the line the marker matches is the step's own, which scales with the Chat font size
  assert.equal(decls('.todo-step')['font-size'], 'var(--fs-chat)');
});

test('no other top-aligned row sizes the svg beside its text in pixels', () => {
  const listed = new Set(MARKERS.map(([, m]) => m));
  const rows = [...DECLS.keys()].filter((s) => /^(flex-)?start$/.test(decls(s)['align-items'] ?? ''));
  assert.ok(rows.length > MARKERS.length, 'the sweep reads the top-aligned rows of the whole stylesheet');
  for (const s of rows.flatMap((row) => [`${row} svg`, `${row} > svg`])) {
    const d = decls(s);
    if (!d['margin-top'] && !d.height) continue;
    assert.ok(listed.has(s), `${s} aligns an icon beside text in a top-aligned row: list it in MARKERS with height: 1lh`);
  }
});
