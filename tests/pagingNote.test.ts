// The note under a page read that shows "Page 1 of 2" (shared/pagingNote.mjs) and where it is told: read_page's answer
// (pageTreeFile.cjs readPageAnswer) and the page tree or diff after an action (pageDiff.cjs). get_page_text's is pinned in
// tests/support/browser-host-tools/computer.ts. #3571: a weekly report took page 1 of the order list for all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pagingNote, withPagingNote } from '../shared/pagingNote.mjs';

const require = createRequire(import.meta.url);
const { readPageAnswer } = require('../electron/capabilities/browser/pageTreeFile.cjs');
const { PageSnapshots } = require('../electron/capabilities/browser/pageDiff.cjs');

const NOTE_ONE = '\n[This is page 1 of 2 of a list: the rest is on the other page. Open it before counting or totalling.]';

test('pagingNote names the page, how many remain and what to do, only when the page is not the last', () => {
  assert.equal(pagingNote(['17 orders', 'Page 1 of 2: 1 2']), NOTE_ONE);
  assert.equal(
    pagingNote(['- text "PAGE 2 of 5"']),
    '\n[This is page 2 of 5 of a list: the rest is on the other pages. Open them before counting or totalling.]',
  );
  // the last page, a page past the end, page 0, a tutorial's "page one of two" and no position say nothing
  for (const line of ['Page 2 of 2', 'Page 3 of 2', 'Page 0 of 2', 'Page one of two', 'a page of notes', 'Homepage 1 of 2', ''])
    assert.equal(pagingNote([line]), '', line);
  assert.equal(pagingNote([]), '');
  // a script's result is JSON: its newlines are the two characters backslash and n, with no word boundary before the P (#3571)
  assert.equal(pagingNote(['"17 orders\\nPage 1 of 2: 1 2"']), NOTE_ONE);
  assert.equal(pagingNote(['"a\\tPage 1 of 2"']), NOTE_ONE);
  assert.equal(pagingNote(['"a\\rPage 1 of 2"']), NOTE_ONE);
  // but a word that ends in "page", or an escaped letter that is not a separator, is not a position
  assert.equal(pagingNote(['"Homepage 1 of 2"']), '');
  assert.equal(pagingNote(['"x\\bPage 1 of 2"']), '');
  // a result with no text, or a non-text entry, says nothing and does not throw
  assert.equal(pagingNote([undefined as any, null as any, 7 as any]), '');
  // a result that also shows the other pages is still told: they may belong to another list (a filtered one) or be a pager's options
  assert.equal(pagingNote(['Page 1 of 2', 'later: Page 2 of 2']), NOTE_ONE);
  assert.equal(
    pagingNote(['Page 3 of 3', 'Page 1 of 3', 'Page 2 of 3']),
    '\n[This is page 1 of 3 of a list: the rest is on the other pages. Open them before counting or totalling.]',
  );
  assert.equal(pagingNote(['Page 1 of 2 (all orders)', 'Page 2 of 2 (filtered)']), NOTE_ONE);
  // the first position that is not the last one counts, in any line
  assert.equal(
    pagingNote(['Page 2 of 2', 'later: Page 1 of 3']),
    '\n[This is page 1 of 3 of a list: the rest is on the other pages. Open them before counting or totalling.]',
  );
});

test('withPagingNote puts the note under a text that shows page 1 of 2, and leaves other text as it is', () => {
  assert.equal(withPagingNote('Page 1 of 2'), `Page 1 of 2${NOTE_ONE}`);
  assert.equal(withPagingNote('no pager'), 'no pager');
});

const tab = { id: 'tab_1', title: 'Orders', url: 'http://shop.test/orders' };
const read = { filter: 'all', depth: 15, ref: null, maxChars: 50000 };
const LINES = ['- main [ref_3]', '  - text "17 orders"', '  - text "Page 1 of 2"', '  - link "2" href="/orders?page=2" [ref_9]'];

test('read_page, saved or not, ends with the note when its tree shows page 1 of 2, and says nothing otherwise', async () => {
  const tabs = { readPage: async () => assert.fail('a whole tree that fits is not read again') };
  const plain = await readPageAnswer(tabs, tab, read, { lines: LINES, truncated: false, save: false, folder: null });
  assert.equal(plain, `Page tab_1: Orders — http://shop.test/orders\n${LINES.join('\n')}${NOTE_ONE}`);
  const none = await readPageAnswer(tabs, tab, read, { lines: ['- text "Page 2 of 2"'], truncated: false, save: false, folder: null });
  assert.equal(none.includes('[This is page'), false);
});

test('a saved read_page summary carries the note too', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const folder = mkdtempSync(path.join(tmpdir(), 'paging-'));
  try {
    const tabs = { readPage: async () => assert.fail('a whole tree that fits is not read again') };
    const out = await readPageAnswer(tabs, tab, read, { lines: LINES, truncated: false, save: true, folder });
    assert.match(out, /is saved to /);
    assert.ok(out.endsWith(NOTE_ONE));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a tree cut at the limit is saved whole, and the notes read the whole tree: a pager below the cut is still told', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const folder = mkdtempSync(path.join(tmpdir(), 'paging-cut-'));
  try {
    const shown = ['- main [ref_3]', '  - text "17 orders"'];
    const whole = [...shown, ...Array.from({ length: 50 }, (_, i) => `  - row "Order ${i}" [ref_${i + 10}]`), '  - text "Page 1 of 2"'];
    const tabs = { readPage: async () => ({ lines: whole, truncated: false }) };
    // the answer's own lines stop before the pager; the saved read finds it
    const out = await readPageAnswer(tabs, tab, read, { lines: shown, truncated: true, save: false, folder });
    assert.match(out, /is saved to /);
    assert.ok(out.endsWith(NOTE_ONE), out.slice(-200));
    // and a cut text run below the cut is told the same way
    const cutTabs = { readPage: async () => ({ lines: [...shown, '  - text "Hello… [+412 chars]"'], truncated: false }) };
    const cut = await readPageAnswer(cutTabs, tab, read, { lines: shown, truncated: true, save: false, folder });
    assert.match(cut, /get_page_text reads the page's whole text\.\]$/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the page tree and the page diff after an action carry the note, after the block the action cap cuts', () => {
  const snaps = new PageSnapshots();
  const t = { id: 't1', chatId: 'c1' };
  const first = snaps.update(t, { url: 'http://shop.test/orders', lines: LINES });
  assert.match(
    first,
    /<\/page_tree>\n\[This is page 1 of 2 of a list: the rest is on the other page\. Open it before counting or totalling\.\]$/,
  );
  // a long tree cut at the action limit still ends with the note
  const long = [...LINES, ...Array.from({ length: 400 }, (_, i) => `- button "Item ${i}" [ref_${i + 20}]`)];
  const cut = new PageSnapshots().update({ id: 't9', chatId: 'c9' }, { url: 'http://shop.test/', lines: long });
  assert.match(cut, /read_page shows the rest\.\]/);
  assert.ok(cut.endsWith(NOTE_ONE));
  // going to page 2 of the same site: a diff whose changed lines show the position
  const base = ['- link "Orders" [ref_1]', '- link "Home" [ref_2]', '- link "Help" [ref_3]', '- text "Page 1 of 2"'];
  snaps.update(t, { url: 'http://shop.test/o', lines: base });
  const diff = snaps.update(t, { url: 'http://shop.test/o', lines: [...base.slice(0, 3), '- text "Page 1 of 3"'] });
  assert.match(diff, /<\/page_diff>\n\[This is page 1 of 3 of a list: the rest is on the other pages\./);
  // the last page: no note
  assert.equal(
    snaps.update(t, { url: 'http://shop.test/o', lines: [...base.slice(0, 3), '- text "Page 3 of 3"'] }).includes('[This is page'),
    false,
  );
});
