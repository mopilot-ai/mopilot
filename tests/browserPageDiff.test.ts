// Page diffs after browser actions (electron/capabilities/browser/pageDiff.cjs): the diff format, ref
// ranges, the full-tree fallbacks and the per-tab baselines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PageSnapshots, diffLines, ranges, ACTION_CHARS } = require('../electron/capabilities/browser/pageDiff.cjs');

const tab = (id = 't1', chatId = 'c1') => ({ id, chatId });

test('ranges collapses consecutive ref numbers and drops duplicates', () => {
  assert.deepEqual(ranges([]), []);
  assert.deepEqual(ranges(['ref_57', 'ref_51', 'ref_52', 'ref_53', 'ref_60', 'ref_52']), ['ref_51..ref_53', 'ref_57', 'ref_60']);
});

test('diffLines marks changed, added (indented) and removed lines, refs as ranges', () => {
  const before = [
    '- button "Add to cart" [ref_42]',
    '- link "A" [ref_51]',
    '- link "B" [ref_52]',
    '- text "Old note"',
    '- link "C" [ref_54]',
  ];
  const after = [
    '- button "Add to cart" [pressed] [ref_42]',
    '- dialog "Cart (1)" [ref_88]',
    '  - button "Checkout" [ref_89]',
    '  - text "Free shipping"',
  ];
  const d = diffLines(before, after);
  assert.deepEqual(d.lines, [
    '~ button "Add to cart" [pressed] [ref_42]',
    '+ dialog "Cart (1)" [ref_88]',
    '+   button "Checkout" [ref_89]',
    '+   text "Free shipping"',
    '- ref_51..ref_52',
    '- ref_54',
    '- text "Old note"',
  ]);
  assert.equal(d.changes, 8);
  // a line that only moved (new indent) is not a change; repeated text lines are matched by occurrence
  assert.deepEqual(diffLines(['- text "x"', '- text "x"', '- a [ref_1]'], ['  - a [ref_1]', '- text "x"', '- text "x"']).lines, []);
  assert.deepEqual(diffLines(['- text "x"'], ['- text "x"', '- text "x"']).lines, ['+ text "x"']);
});

test('without a baseline, the update is the full tree in the compact default scope', () => {
  const s = new PageSnapshots();
  const t = tab();
  assert.deepEqual(s.options(t), { filter: 'interactive', depth: 15, maxChars: 50000 });
  assert.equal(
    s.update(t, { url: 'https://a.example/', lines: ['- button "Go" [ref_1]'] }),
    '<page_tree>\nFull page tree (no earlier read of this tab to compare with), interactive elements in the viewport:\n- button "Go" [ref_1]\n</page_tree>',
  );
  // the page read is the new baseline: the same page again has no changes
  assert.equal(
    s.update(t, { url: 'https://a.example/#x', lines: ['- button "Go" [ref_1]'] }),
    '<page_diff>No visible change (interactive elements in the viewport).</page_diff>',
  );
});

test('a diff against what the model read, with its filter; another page or a mostly new tree is a full tree', () => {
  const s = new PageSnapshots();
  const t = tab();
  const base = ['- heading "Shop" [ref_1]', '- button "Add" [ref_2]', '- link "Help" [ref_3]', '- link "About" [ref_4]'];
  s.seen(t, { url: 'https://a.example/p', opts: { filter: 'visible', depth: 15, maxChars: 50000 }, lines: base });
  assert.equal(s.options(t).filter, 'visible');
  assert.equal(
    s.update(t, { url: 'https://a.example/p', lines: [...base.slice(0, 1), '- button "Add" [pressed] [ref_2]', ...base.slice(2)] }),
    '<page_diff>\n~ button "Add" [pressed] [ref_2]\n</page_diff>',
  );
  assert.match(
    s.update(t, { url: 'https://a.example/other', lines: ['- button "X" [ref_9]'], truncated: true }),
    /^<page_tree>\nFull page tree \(the tab is on another page now\), elements in the viewport:\n- button "X" \[ref_9\]\n\[Tree truncated at the character limit\.\]\n<\/page_tree>$/,
  );
  assert.match(
    s.update(t, { url: 'https://a.example/other', lines: ['- button "Y" [ref_10]', '- button "Z" [ref_11]'] }),
    /^<page_tree>\nFull page tree \(most of the page changed\), elements in the viewport:/,
  );
  assert.match(s.update(t, { url: 'https://a.example/other', lines: [] }), /\(nothing to show\)\n<\/page_tree>$/);
});

test("an unknown filter reads as the viewport and long output is capped at the model's limit", () => {
  const s = new PageSnapshots();
  const t = tab();
  s.seen(t, { url: 'u', opts: { filter: 'odd', maxChars: 1000 }, lines: ['- a [ref_1]', '- b [ref_2]', '- c [ref_3]', '- d [ref_4]'] });
  assert.equal(s.options(t).depth, 15);
  const long = `- x "${'y'.repeat(1200)}" [ref_4]`;
  const out = s.update(t, { url: 'u', lines: ['- a [ref_1]', '- b [ref_2]', '- c [ref_3]', long] });
  assert.match(out, /^<page_diff>\n~ x "y+/);
  assert.match(out, /\n\[Truncated at the 1,000-character limit\.\]$/);
  assert.equal(out.length, 1000 + '\n[Truncated at the 1,000-character limit.]'.length);
  const full = s.update(t, { url: 'v', lines: [long] });
  assert.match(full, /^<page_tree>\nFull page tree \(the tab is on another page now\), elements in the viewport:/);
  assert.match(full, /\[Truncated at the 1,000-character limit\.\]$/);
});

test('G10: after an action a wide read is held to ACTION_CHARS, with read_page for the rest; a smaller limit still wins', () => {
  const s = new PageSnapshots();
  const t = tab();
  const many = Array.from({ length: 600 }, (_, i) => `- link "item ${i} ${'z'.repeat(20)}" [ref_${i + 1}]`);
  s.seen(t, { url: 'https://a.example/', opts: { filter: 'all' }, lines: many.slice(0, 10) });
  const full = s.update(t, { url: 'https://a.example/', lines: many });
  assert.match(full, /^<page_tree>\nFull page tree \(most of the page changed\), all elements:/);
  const note = `\n[Cut at ${ACTION_CHARS.toLocaleString('en-US')} characters after the action: read_page shows the rest.]`;
  assert.ok(full.endsWith(note));
  assert.equal(full.length, ACTION_CHARS + note.length);
  // a diff is held to it too
  const changed = many.map((l, i) => (i % 3 ? l : l.replace('item', 'ITEM')));
  const diff = s.update(t, { url: 'https://a.example/', lines: changed });
  assert.match(diff, /^<page_diff>\n~ /);
  assert.ok(diff.endsWith(note));
  // a short result is left whole
  assert.equal(s.update(t, { url: 'https://a.example/', lines: changed }), '<page_diff>No visible change (all elements).</page_diff>');
});

test('browser_find results update the baseline lines the model saw; tabs and chats are separate; turn end resets', () => {
  const s = new PageSnapshots();
  const t = tab();
  s.saw(t, ['- button "Go" [ref_1]']); // no baseline: nothing to update
  assert.equal(s.get(t), null);
  s.seen(t, { url: 'u', opts: {}, lines: ['- form [ref_5]', '  - button "Go" [ref_1]', '  - text "hi"'] });
  s.saw(t, ['- button "Go" [disabled] [ref_1]', '- link "New" [ref_7]']);
  assert.deepEqual(s.get(t).lines, ['- form [ref_5]', '  - button "Go" [disabled] [ref_1]', '  - text "hi"']);
  // another Tab object with the same id (the pane remounted it) has no baseline
  assert.equal(s.get(tab()), null);
  assert.equal(s.get(tab('t2')), null);
  assert.equal(s.get(tab('t1', 'c2')), null);
  s.reset('c1');
  assert.equal(s.get(t), null);
});
