// Text cut short for the model (shared/clippedText.mjs) and where its note is told: read_page's answer
// (pageTreeFile.cjs readPageAnswer), the page tree or diff after an action (pageDiff.cjs) and computer use's element lines
// (appScopedUtil.cjs elementLine). #3571: Codex × IAB stopped on an email whose body read_page cut with a bare "…".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clip, clippedNote } from '../shared/clippedText.mjs';

const require = createRequire(import.meta.url);
const { readPageAnswer } = require('../electron/capabilities/browser/pageTreeFile.cjs');
const { PageSnapshots } = require('../electron/capabilities/browser/pageDiff.cjs');
const { elementLine } = require('../electron/capabilities/tools/appScopedUtil.cjs');

const NOTE = '[Text ending "… [+N chars]" is cut there: get_page_text reads the page\'s whole text.]';
const CUT = '- text "Hi Tariq, Start date: the first Mond… [+412 chars]"';

test('clip keeps text that fits and marks a cut with how much was left out', () => {
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip('abcdef', 4), 'abc… [+3 chars]');
  // never half of an emoji at the cut: the left-out count includes the dropped half
  assert.equal(clip('ab😀cd', 4), 'ab… [+4 chars]');
});

test('clippedNote names get_page_text only when a line holds a cut', () => {
  assert.equal(clippedNote(['- text "short"', '- link "…more" [ref_2]']), '');
  assert.equal(clippedNote([]), '');
  assert.equal(clippedNote(['- heading "Mail" [ref_1]', `  ${CUT}`]), `\n${NOTE}`);
});

const tab = { id: 'tab_1', title: 'New hire · Mail', url: 'http://mail.localhost/m/MSG-1' };
const read = { filter: 'all', depth: 15, ref: null, maxChars: 50000 };

test('read_page tells the model where a cut text run continues, and says nothing when none was cut', async () => {
  const tabs = { readPage: async () => assert.fail('a whole tree that fits is not read again') };
  const cut = await readPageAnswer(tabs, tab, read, { lines: ['- main [ref_3]', `  ${CUT}`], truncated: false, save: false, folder: null });
  assert.equal(cut, `Page tab_1: New hire · Mail — http://mail.localhost/m/MSG-1\n- main [ref_3]\n  ${CUT}\n${NOTE}`);
  const whole = await readPageAnswer(tabs, tab, read, { lines: ['- text "short"'], truncated: false, save: false, folder: null });
  assert.equal(whole.includes('get_page_text'), false);
});

test('a saved read_page summary carries the note too', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'clipped-'));
  try {
    const tabs = { readPage: async () => assert.fail('a whole tree that fits is not read again') };
    const out = await readPageAnswer(tabs, tab, read, { lines: [`  ${CUT}`], truncated: false, save: true, folder });
    assert.match(out, /is saved to /);
    assert.ok(out.endsWith(`\n${NOTE}`));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a long page tree cut at the action limit still ends with the note', () => {
  const lines = [CUT, ...Array.from({ length: 400 }, (_, i) => `- button "Item ${i}" [ref_${i + 10}]`)];
  const out = new PageSnapshots().update({ id: 't9', chatId: 'c9' }, { url: 'http://x.test/', lines });
  assert.match(out, /\[Cut at [\d,]+ characters after the action: read_page shows the rest\.\]\n\[Text ending/);
  assert.ok(out.endsWith(NOTE));
});

test('a page tree and a page diff after an action carry the note when they show a cut', () => {
  const snaps = new PageSnapshots();
  const t = { id: 't1', chatId: 'c1' };
  const first = snaps.update(t, { url: 'http://x.test/a', lines: [CUT] });
  // after the block, so the cap on an action's view never cuts the note away
  assert.match(first, /^<page_tree>\n[\s\S]*\n<\/page_tree>\n\[Text ending "… \[\+N chars\]" is cut there: get_page_text reads/);
  const lines = ['- button "A" [ref_1]', '- button "B" [ref_2]', '- button "C" [ref_3]', '- text "short"'];
  snaps.update(t, { url: 'http://x.test/b', lines });
  const diff = snaps.update(t, { url: 'http://x.test/b', lines: [...lines.slice(0, 3), CUT] });
  assert.equal(diff, `<page_diff>\n+ text "Hi Tariq, Start date: the first Mond… [+412 chars]"\n- text "short"\n</page_diff>\n${NOTE}`);
  // going back lists the cut line as removed: the page no longer shows a cut, so there is no note; a diff that shows no cut has none
  assert.equal(snaps.update(t, { url: 'http://x.test/b', lines }).includes('get_page_text'), false);
  const plain = snaps.update(t, { url: 'http://x.test/b', lines: [...lines.slice(0, 3), '- text "other"'] });
  assert.equal(plain, '<page_diff>\n+ text "other"\n- text "short"\n</page_diff>');
});

test("computer use's element line marks a cut label instead of ending mid-word", () => {
  const el = (label: string) => ({ index: 2, role: 'AXTextArea', label, center: { x: 1, y: 2 }, enabled: true });
  assert.equal(elementLine(el('Short')), '[2] TextArea "Short" at (1, 2)');
  const long = `PASSPORT (scan, OCR text)\nSurname: YILMAZ ${'x'.repeat(100)}`;
  assert.equal(elementLine(el(long)), `[2] TextArea "${long.replace(/\s+/g, ' ').slice(0, 79)}… [+${long.length - 79} chars]" at (1, 2)`);
});
