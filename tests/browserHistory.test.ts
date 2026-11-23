// The built-in browser's history and bookmarks: page addresses worth keeping, the history store and its ranking,
// the bookmark store, the address bar's suggestions, the recorder that feeds history, and their IPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { cleanPageUrl, agentView, MAX_URL } = require('../electron/capabilities/browser/pageUrl.cjs');
const { HistoryStore, typedForm, matchRank, IMPORT_PREFIX } = require('../electron/capabilities/browser/historyStore.cjs');
const { BookmarkStore, MAX_ITEMS } = require('../electron/capabilities/browser/bookmarkStore.cjs');
const { suggest } = require('../electron/capabilities/browser/suggest.cjs');
const { attachHistory } = require('../electron/capabilities/browser/historyRecorder.cjs');
const { createBrowserData } = require('../electron/capabilities/browser/data.cjs');
const { register } = require('../electron/app/ipc/browserData.cjs');
const { BrowserStorage } = require('../electron/capabilities/browser/storage.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-history-test-'));
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

test('cleanPageUrl: plain http(s) pages only, without credentials or fragments', () => {
  assert.equal(cleanPageUrl(' https://example.test/a?b=1#frag '), 'https://example.test/a?b=1');
  assert.equal(cleanPageUrl('http://example.test'), 'http://example.test/');
  for (const bad of [
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'not a url',
    'https://u:p@example.test/',
    'https://u@example.test/',
    42,
    null,
  ]) {
    assert.equal(cleanPageUrl(bad), null, String(bad));
  }
  assert.equal(cleanPageUrl(`https://example.test/${'a'.repeat(MAX_URL)}`), null, 'too long after parsing');
  assert.equal(cleanPageUrl(`https://example.test/${'a'.repeat(MAX_URL * 2)}`), null, 'far too long before parsing');
});

test('agentView: blocked addresses vanish, high-risk sites show their host only, the rest pass through', () => {
  assert.equal(agentView('http://169.254.169.254/latest/meta-data/'), null);
  assert.deepEqual(agentView('https://www.chase.com/personal/reset?token=abc'), { url: 'https://www.chase.com/', risk: 'high' });
  assert.deepEqual(agentView('https://example.test/a?b=1'), { url: 'https://example.test/a?b=1' });
});

test('typedForm and matchRank: typed text matches hosts first, then addresses, then anything inside', () => {
  assert.equal(typedForm('  HTTPS://WWW.Example.test/A '), 'example.test/a');
  assert.equal(typedForm(undefined), '');
  const row = { url: 'https://www.example.test/docs/api', title: 'Reference Manual' };
  assert.equal(matchRank(row, ''), 1);
  assert.equal(matchRank(row, 'exam'), 3, 'host prefix');
  assert.equal(matchRank(row, 'example.test/do'), 2, 'address prefix');
  assert.equal(matchRank(row, 'api'), 1, 'inside the address');
  assert.equal(matchRank(row, 'manual'), 1, 'inside the title');
  assert.equal(matchRank(row, 'ttps'), 0, 'only in the scheme the user never sees');
});

function history(opts: any = {}) {
  const dir = tmp();
  let clock = T0;
  const store = new HistoryStore({ file: path.join(dir, 'sub', 'h.sqlite'), now: () => clock, safeStorage: fakeSafe(), ...opts });
  return { store, dir, tick: (ms: number) => (clock += ms), set: (t: number) => (clock = t) };
}

test('HistoryStore.record: counts visits, keeps the latest title, drops fragments and pages that are not http(s)', () => {
  const { store, tick } = history();
  assert.equal(store.record({ url: 'https://a.test/x#one', title: 'First' }), true);
  tick(1000);
  assert.equal(store.record({ url: 'https://a.test/x#two', title: '', typed: true }), true);
  assert.equal(store.record({ url: 'file:///secret' }), false);
  assert.equal(store.record({ url: 'https://untitled.test/', title: null }), true, 'no title is fine');
  assert.equal(store.count(), 2);
  const [row] = store.search({ query: 'a.test' });
  assert.deepEqual(row, { url: 'https://a.test/x', title: 'First', lastVisit: T0 + 1000, visitCount: 2 });
  // an older visit never moves the last visit back
  store.record({ url: 'https://a.test/x', at: T0 - DAY });
  assert.equal(store.search({ query: 'a.test' })[0].lastVisit, T0 + 1000);
  store.setTitle('https://a.test/x#frag', 'Renamed');
  store.setTitle('file:///x', 'ignored');
  store.setTitle('https://a.test/x', '');
  assert.equal(store.search({ query: 'a.test' })[0].title, 'Renamed');
  store.close();
});

test('HistoryStore.search: titles and addresses match typed text whatever their case, beyond ASCII too', () => {
  const { store } = history();
  store.record({ url: 'https://de.test/', title: 'Über uns' });
  store.record({ url: 'https://fr.test/', title: 'ÉCOLE de musique' });
  assert.deepEqual(
    ['über', 'ÜBER', 'école', 'Musique'].map((q) => store.search({ query: q }).map((r) => r.url)),
    [['https://de.test/'], ['https://de.test/'], ['https://fr.test/'], ['https://fr.test/']],
  );
  store.close();
});

test('HistoryStore.search: ranks host matches above address and title matches, favours frequent and recent pages, honours since and limit', () => {
  const { store, set } = history();
  const visit = (url: string, title: string, times: number, at: number) => {
    for (let i = 0; i < times; i++) store.record({ url, title, at });
  };
  visit('https://other.test/git-notes', 'Notes', 1, T0);
  visit('https://git.test/', 'Git home', 1, T0 - 40 * DAY);
  visit('https://gitlab.test/a', 'Lab', 5, T0 - 1 * DAY);
  visit('https://x.test/y', 'About git', 1, T0 - 2 * DAY);
  set(T0);
  const urls = (q: any) => store.search(q).map((r: any) => r.url);
  // host prefix first (busier and more recent first among them), then address prefix, then anywhere
  assert.deepEqual(urls({ query: 'git' }), [
    'https://gitlab.test/a',
    'https://git.test/',
    'https://other.test/git-notes',
    'https://x.test/y',
  ]);
  assert.deepEqual(urls({ query: 'git', limit: 2 }), ['https://gitlab.test/a', 'https://git.test/']);
  assert.deepEqual(urls({ query: 'git', since: T0 - 3 * DAY }), [
    'https://gitlab.test/a',
    'https://other.test/git-notes',
    'https://x.test/y',
  ]);
  // no text: most recent pages, without reordering them by frequency
  assert.deepEqual(urls({ limit: 2 }), ['https://other.test/git-notes', 'https://gitlab.test/a']);
  assert.equal(store.search().length, 4);
  assert.deepEqual(urls({ query: 'ttps' }), [], 'a match in the hidden scheme is not a match');
  assert.deepEqual(urls({ query: '%' }), [], 'wildcards are literal');
  assert.equal(store.search({ query: 'git', limit: 'x' as any }).length, 4);
  store.close();
});

test('HistoryStore.search: a page visited often is still found among many recent pages that merely contain the text', () => {
  const { store } = history();
  for (let i = 0; i < 500; i++) store.record({ url: `https://blog${i}.test/posts/git-notes-${i}`, at: T0 - i });
  for (let i = 0; i < 10; i++) store.record({ url: 'https://github.test/', title: 'GitHub', at: T0 - 60 * DAY });
  assert.equal(store.search({ query: 'git' })[0].url, 'https://github.test/');
  store.close();
});

test('history ranking considers a host prefix beyond frequent title-match candidates', () => {
  const { store } = history();
  store.importVisits(
    Array.from({ length: 401 }, (_, i) => ({ url: `https://other${i}.test/`, title: 'Git notes', lastVisit: T0, visitCount: 20 })),
    'chrome',
  );
  store.record({ url: 'https://github.test/', title: 'Home', at: T0 - DAY });
  assert.equal(store.search({ query: 'git', limit: 1 })[0].url, 'https://github.test/');
  store.close();
});

test('history without a query returns recency order even for a frequently visited older page', () => {
  const { store } = history();
  for (let i = 0; i < 20; i++) store.record({ url: 'https://older.test/', at: T0 - DAY });
  store.record({ url: 'https://recent.test/', at: T0 });
  assert.deepEqual(
    store.search({ limit: 2 }).map((r: any) => r.url),
    ['https://recent.test/', 'https://older.test/'],
  );
  store.close();
});

test('history relevance priority cannot be overwhelmed by imported visit counts', () => {
  const { store } = history();
  store.importVisits([{ url: 'https://other.test/', title: 'Git notes', lastVisit: T0, visitCount: 10_000_000 }], 'chrome');
  store.record({ url: 'https://github.test/', title: 'Home', at: T0 - DAY });
  assert.equal(store.search({ query: 'git', limit: 1 })[0].url, 'https://github.test/');
  store.close();
});

test('frequency cannot make a hidden scheme-only history match visible', () => {
  const { store } = history();
  store.importVisits([{ url: 'https://other.test/', title: 'Home', lastVisit: T0, visitCount: 10_000_000 }], 'chrome');
  assert.deepEqual(store.search({ query: 'ttps' }), []);
  store.close();
});

test('HistoryStore: pages beyond the cap are dropped, oldest first', () => {
  const { store } = history({ max: 3 });
  for (let i = 0; i < 200; i++) store.record({ url: `https://p${i}.test/`, at: T0 + i });
  assert.equal(store.count(), 3);
  assert.deepEqual(
    store.search().map((r: any) => r.url),
    ['https://p199.test/', 'https://p198.test/', 'https://p197.test/'],
  );
  store.close();
});

test('HistoryStore.importVisits: new pages are added with their source, existing and invalid ones are counted and left alone', () => {
  const { store } = history();
  store.record({ url: 'https://have.test/', title: 'Mine' });
  const out = store.importVisits(
    [
      { url: 'https://have.test/', title: 'Theirs', lastVisit: T0, visitCount: 9 },
      { url: 'https://new.test/', title: 'New', lastVisit: T0 - DAY, visitCount: 3, typedCount: 2 },
      { url: 'https://bare.test/', lastVisit: T0 - DAY },
      { url: 'ftp://nope.test/', lastVisit: T0 },
      { url: 'https://nolast.test/', lastVisit: 'x' },
      { url: 'https://zero.test/', lastVisit: 0 },
      { url: 'https://future.test/', lastVisit: T0 + 5 * DAY },
      null,
    ],
    'chrome',
  );
  assert.deepEqual(out, { imported: 2, skippedExisting: 1, skippedInvalid: 5 });
  assert.equal(store.search({ query: 'have.test' })[0].title, 'Mine');
  assert.deepEqual(store.importedSources(), [{ source: 'chrome', count: 2 }]);
  store.importVisits([{ url: 'https://s.test/', lastVisit: T0 }], 'safari');
  assert.deepEqual(store.importedSources(), [
    { source: 'chrome', count: 2 },
    { source: 'safari', count: 1 },
  ]);
  // visiting an imported page makes it the user's own
  store.record({ url: 'https://new.test/' });
  assert.deepEqual(store.importedSources(), [
    { source: 'chrome', count: 1 },
    { source: 'safari', count: 1 },
  ]);
  assert.equal(store.deleteImported('chrome'), 1);
  assert.equal(store.deleteImported(), 1);
  assert.equal(store.deleteImported(), 0);
  assert.equal(IMPORT_PREFIX, 'import:');
  store.close();
});

test('HistoryStore.importVisits: a failure part way rolls the whole import back', () => {
  const { store } = history();
  const bad = {
    url: 'https://boom.test/',
    lastVisit: T0,
    get title(): string {
      throw new Error('unreadable');
    },
  };
  assert.throws(() => store.importVisits([{ url: 'https://ok.test/', lastVisit: T0 }, bad], 'chrome'), /unreadable/);
  assert.equal(store.count(), 0);
  store.close();
});

test('HistoryStore.remove and clear', () => {
  const { store } = history();
  store.record({ url: 'https://a.test/' });
  store.record({ url: 'https://b.test/' });
  store.remove('https://a.test/#x');
  store.remove('nonsense');
  assert.deepEqual(
    store.search().map((r: any) => r.url),
    ['https://b.test/'],
  );
  store.clear();
  assert.equal(store.count(), 0);
  store.close();
});

test('HistoryStore: a database that will not open turns history off without throwing', () => {
  const { store } = history({
    open: () => {
      throw new Error('disk full');
    },
  });
  assert.equal(store.record({ url: 'https://a.test/' }), false);
  store.setTitle('https://a.test/', 't');
  assert.deepEqual(store.search({ query: 'a' }), []);
  assert.deepEqual(
    store.importVisits(
      [
        { url: 'https://a.test/', lastVisit: T0 },
        { url: 'https://b.test/', lastVisit: T0 },
      ],
      'chrome',
    ),
    {
      imported: 0,
      skippedExisting: 0,
      skippedInvalid: 2,
    },
  );
  assert.deepEqual(store.importedSources(), []);
  assert.equal(store.deleteImported('chrome'), 0);
  store.remove('https://a.test/');
  store.clear();
  assert.equal(store.count(), 0);
  store.close();
});

test('HistoryStore.close: a database that fails to close is only noted', () => {
  const { store } = history({
    open: () => ({
      exec() {},
      prepare: () => ({ all: () => [], get: () => ({ n: 0 }), run: () => ({ changes: 0 }) }),
      close() {
        throw new Error('already closed');
      },
    }),
  });
  assert.equal(store.count(), 0);
  store.close();
  store.close();
});

function bookmarks(now = T0) {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'b.json');
  return { file, make: () => new BookmarkStore({ file, now: () => now }) };
}

test('bookmark title and folder limits preserve Unicode for local, loaded and imported items', () => {
  const { make, file } = bookmarks();
  const store = make();
  const title = 'x'.repeat(299) + '🙂tail';
  const expected = 'x'.repeat(299) + '🙂';
  const folder = 'f'.repeat(99) + '🙂tail';
  store.toggle({ url: 'https://local.test/', title });
  assert.equal(store.list()[0].title, expected);
  store.importItems([{ url: 'https://import.test/', title, folderPath: [folder] }], 'Chrome', 'chrome');
  const imported = store.list().find((b: any) => b.url === 'https://import.test/');
  assert.equal(imported.title, expected);
  assert.equal(imported.folderPath.at(-1), 'f'.repeat(99) + '🙂');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.items.push({ id: 'loaded', url: 'https://loaded.test/', title, folderPath: [folder] });
  fs.writeFileSync(file, JSON.stringify(data));
  const loaded = make()
    .list()
    .find((b: any) => b.id === 'loaded');
  assert.equal(loaded.title, expected);
  assert.equal(loaded.folderPath[0], 'f'.repeat(99) + '🙂');
});

test('BookmarkStore.toggle: the star adds a page, and removes every bookmark of it', () => {
  const { make, file } = bookmarks();
  const store = make();
  assert.deepEqual(store.toggle({ url: 'https://a.test/#x', title: 'A' }), { bookmarked: true, ok: true });
  assert.deepEqual(store.toggle({ url: 'about:blank' }), { bookmarked: false, ok: false });
  assert.equal(store.find('https://a.test/')[0].title, 'A');
  assert.deepEqual(store.find('nonsense'), []);
  // it is on disk, privately, and a new store reads it back
  assert.equal(make().list().length, 1);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.deepEqual(store.toggle({ url: 'https://a.test/' }), { bookmarked: false, ok: true });
  assert.deepEqual(store.list(), []);
  // a page without a title is named by its address
  store.toggle({ url: 'https://b.test/' });
  assert.equal(store.list()[0].title, 'https://b.test/');
});

test('BookmarkStore: a missing or damaged file is an empty list; stored items are cleaned', () => {
  const { make, file } = bookmarks();
  assert.deepEqual(make().list(), []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(make().list(), []);
  // …which is never saved over: the star and an import say why, the file stays, and a copy is kept
  const damaged = make();
  assert.throws(
    () => damaged.toggle({ url: 'https://new.test/' }),
    /Couldn't read the saved bookmarks \(.*JSON.*\), so they weren't changed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{ not json');
  // Clear browsing data still clears it
  damaged.clear();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
  fs.writeFileSync(file, JSON.stringify({ items: 'nope' }));
  assert.deepEqual(make().list(), []);
  assert.throws(() => make().toggle({ url: 'https://new.test/' }), /Invalid saved state for browser bookmarks/);
  fs.writeFileSync(
    file,
    JSON.stringify({
      items: [
        { id: 'keep', title: 'T', url: 'https://ok.test/#f', folderPath: [' A ', '', 5, 'B'], addedAt: 7, source: 'import:chrome' },
        { url: 'https://noid.test/', folderPath: 'x', source: 3 },
        { id: 'bad', url: 'file:///x' },
        null,
      ],
    }),
  );
  const list = make().list();
  assert.equal(list.length, 2);
  assert.deepEqual(
    { ...list[0] },
    { id: 'keep', title: 'T', url: 'https://ok.test/', folderPath: ['A', '5', 'B'], addedAt: 7, source: 'import:chrome' },
  );
  assert.equal(list[1].source, 'local');
  assert.deepEqual(list[1].folderPath, []);
  assert.ok(list[1].id.length > 8);
  assert.equal(list[1].title, '');
});

test('BookmarkStore.importItems: bookmarks land under "Imported from <Browser>", once', () => {
  const { make } = bookmarks();
  const store = make();
  const items = [
    { title: 'Docs', url: 'https://docs.test/', folderPath: ['Bookmarks bar', null, 'Work'], addedAt: 5 },
    { title: '', url: 'https://bare.test/', folderPath: [] },
    { title: 'Dup', url: 'https://docs.test/#again', folderPath: ['Bookmarks bar', 'Work'] },
    { title: 'Bad', url: 'javascript:1' },
    null,
  ];
  assert.deepEqual(store.importItems(items, 'Chrome', 'chrome'), { imported: 2, skippedExisting: 1, skippedInvalid: 2 });
  const [docs, bare] = store.list();
  assert.deepEqual(docs.folderPath, ['Imported from Chrome', 'Bookmarks bar', 'Work']);
  assert.equal(docs.addedAt, 5);
  assert.equal(bare.title, 'https://bare.test/');
  assert.equal(bare.addedAt, T0, 'no date: the import time');
  assert.equal(store.importedSources().length, 1);
  // again: nothing new, and nothing written
  assert.deepEqual(store.importItems(items, 'Chrome', 'chrome').imported, 0);
  store.importItems([{ title: 'S', url: 'https://s.test/', folderPath: ['Favorites'] }], 'Safari', 'safari');
  assert.deepEqual(store.importedSources(), [
    { source: 'chrome', count: 2 },
    { source: 'safari', count: 1 },
  ]);
  assert.equal(store.deleteImported('safari'), 1);
  assert.equal(store.deleteImported(), 2);
  assert.equal(store.deleteImported(), 0);
});

test('BookmarkStore.importItems: folder text cannot collide with the separators of a different hierarchy', () => {
  const { make } = bookmarks();
  const store = make();
  const incoming = [
    { url: 'https://same.test/', title: 'One folder', folderPath: ['A\u0000B'] },
    { url: 'https://same.test/', title: 'Two folders', folderPath: ['A', 'B'] },
  ];
  assert.deepEqual(store.importItems(incoming, 'Chrome', 'chrome'), { imported: 2, skippedExisting: 0, skippedInvalid: 0 });
  assert.deepEqual(
    store.list().map((item: any) => item.folderPath),
    [
      ['Imported from Chrome', 'A\u0000B'],
      ['Imported from Chrome', 'A', 'B'],
    ],
  );
  const restarted = make();
  assert.deepEqual(restarted.list(), store.list());
  assert.deepEqual(restarted.importItems(incoming, 'Chrome', 'chrome'), { imported: 0, skippedExisting: 2, skippedInvalid: 0 });
});

test('deep imported bookmark paths keep the same identity after reload and reimport', () => {
  const { make } = bookmarks();
  const incoming = [{ url: 'https://deep.test/', title: 'Deep', folderPath: Array.from({ length: 14 }, (_, i) => `Folder ${i}`) }];
  const store = make();
  assert.equal(store.importItems(incoming, 'Chrome', 'chrome').imported, 1);
  const longName = 'Chrome'.repeat(30) + '🙂';
  assert.equal(store.importItems([{ url: 'https://long-root.test/', folderPath: [] }], longName, 'custom').imported, 1);
  const original = store.list();
  const reopened = make();
  assert.deepEqual(reopened.list(), original, 'stored folder identity survives a reload');
  assert.equal(reopened.importItems(incoming, 'Chrome', 'chrome').skippedExisting, 1);
  assert.equal(reopened.importItems([{ url: 'https://long-root.test/', folderPath: [] }], longName, 'custom').skippedExisting, 1);
  assert.equal(reopened.list().length, 2, 'reimport does not duplicate a deep bookmark or long import root');
});

test('import folder whitespace exposed by truncation is canonical before persistence', () => {
  const { make } = bookmarks();
  const incoming = [{ url: 'https://boundary.test/', folderPath: ['x'.repeat(99) + ' tail'] }];
  const name = 'a'.repeat(85) + ' tail';
  const store = make();
  store.importItems(incoming, name, 'custom');
  const before = store.list();
  assert.deepEqual(make().list(), before);
  assert.equal(make().importItems(incoming, name, 'custom').skippedExisting, 1);
});

test('BookmarkStore: a write that fails leaves the list as the disk has it', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, '');
  const store = new BookmarkStore({ file: path.join(blocker, 'b.json'), now: () => T0 });
  assert.throws(() => store.toggle({ url: 'https://a.test/', title: 'A' }));
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.importItems([{ title: 'B', url: 'https://b.test/' }], 'Chrome', 'chrome'));
  assert.deepEqual(store.list(), []);
});

test('BookmarkStore: the cap stops imports and the star, and clear empties the list', () => {
  const { make, file } = bookmarks();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    id: `i${i}`,
    title: 't',
    url: `https://s${i}.test/`,
    folderPath: [],
    addedAt: i,
    source: 'local',
  }));
  fs.writeFileSync(file, JSON.stringify({ items }));
  const store = make();
  assert.deepEqual(store.toggle({ url: 'https://new.test/' }), { bookmarked: false, ok: false });
  assert.equal(store.importItems([{ url: 'https://new.test/', title: 'n' }], 'Chrome', 'chrome').skippedInvalid, 1);
  assert.equal(store.remove('i0'), true);
  assert.equal(store.remove('i0'), false);
  store.clear();
  assert.deepEqual(make().list(), []);
});

test('BookmarkStore.search: by text, folder and limit, newest first', () => {
  const { make } = bookmarks();
  const store = make();
  store.importItems(
    [
      { title: 'API Docs', url: 'https://docs.test/api', folderPath: ['Work'], addedAt: 3 },
      { title: 'Recipes', url: 'https://food.test/', folderPath: ['Home'], addedAt: 2 },
      { title: 'Blog', url: 'https://docs.test/blog', folderPath: ['Work'], addedAt: 1 },
    ],
    'Chrome',
    'chrome',
  );
  const titles = (o?: any) => store.search(o).map((b: any) => b.title);
  assert.deepEqual(titles(), ['API Docs', 'Recipes', 'Blog']);
  assert.deepEqual(titles({ query: 'docs' }), ['API Docs', 'Blog']);
  assert.deepEqual(titles({ query: 'recipes' }), ['Recipes']);
  assert.deepEqual(titles({ folder: 'work' }), ['API Docs', 'Blog']);
  assert.deepEqual(titles({ folder: 'Work', query: 'blog', limit: 1 }), ['Blog']);
  assert.deepEqual(titles({ limit: 'x' as any }), ['API Docs', 'Recipes', 'Blog']);
  assert.deepEqual(titles({ folder: null as any, query: null as any }), ['API Docs', 'Recipes', 'Blog']);
  assert.deepEqual(Object.keys(store.search()[0]).sort(), ['addedAt', 'folderPath', 'id', 'title', 'url']);
});

test('suggestions count unique bookmark URLs before applying the row limit', () => {
  const { make } = bookmarks();
  const store = make();
  const duplicates = Array.from({ length: 8 }, (_, i) => ({
    url: 'https://duplicate.test/',
    title: 'Match repeated',
    folderPath: [`Folder ${i}`],
    addedAt: 100 + i,
  }));
  store.importItems(
    [
      ...duplicates,
      { url: 'https://one.test/', title: 'Match one', folderPath: [], addedAt: 2 },
      { url: 'https://two.test/', title: 'Match two', folderPath: [], addedAt: 1 },
    ],
    'Chrome',
    'chrome',
  );
  const results = suggest({ bookmarks: store, history: { search: () => [] } }, 'Match', 3);
  assert.deepEqual(
    results.map((r) => r.url),
    ['https://duplicate.test/', 'https://one.test/', 'https://two.test/'],
  );
  assert.equal(store.search({ query: 'Match', limit: 3 }).length, 3, 'normal bookmark search keeps folder copies');
});

test('suggest: bookmarks first, then history, one row per address, bounded', () => {
  const stores = {
    bookmarks: {
      search: () => [
        { url: 'https://a.test/', title: 'A bookmark' },
        { url: 'https://b.test/', title: 'B' },
      ],
    },
    history: {
      search: () => [
        { url: 'https://a.test/', title: 'A page' },
        { url: 'https://c.test/', title: 'C' },
        { url: 'https://d.test/', title: 'D' },
      ],
    },
  };
  assert.deepEqual(suggest(stores, ' a '), [
    { kind: 'bookmark', url: 'https://a.test/', title: 'A bookmark' },
    { kind: 'bookmark', url: 'https://b.test/', title: 'B' },
    { kind: 'history', url: 'https://c.test/', title: 'C' },
    { kind: 'history', url: 'https://d.test/', title: 'D' },
  ]);
  assert.equal(suggest(stores, 'a', 1).length, 1);
  assert.equal(suggest(stores, 'a', 3).length, 3);
  assert.deepEqual(suggest(stores, '   '), []);
  assert.deepEqual(suggest(stores, undefined as any), []);
});

class FakeWc extends EventEmitter {
  url: string;
  constructor(url = 'https://a.test/') {
    super();
    this.url = url;
  }
  getURL() {
    return this.url;
  }
}

test('attachHistory: records main-frame navigations and titles in the shared profile only', () => {
  const log: any[] = [];
  const wc = new FakeWc();
  let shared = true;
  attachHistory(wc as any, {
    history: () => ({
      record: (o: any) => (log.push(['record', o.url]), true),
      setTitle: (u: string, t: string) => log.push(['title', u, t]),
    }),
    isShared: () => shared,
  });
  wc.emit('did-navigate', {}, 'https://a.test/', 200);
  wc.emit('did-navigate', {}, 'https://a.test/missing', 404);
  wc.emit('did-navigate', {}, 'https://a.test/ok', undefined);
  wc.emit('page-title-updated', {}, 'A title');
  shared = false;
  wc.emit('did-navigate', {}, 'https://private.test/', 200);
  wc.emit('page-title-updated', {}, 'Private');
  assert.deepEqual(log, [
    ['record', 'https://a.test/'],
    ['record', 'https://a.test/ok'],
    ['title', 'https://a.test/', 'A title'],
  ]);
});

test('attachHistory: a failing store never breaks the page', () => {
  const wc = new FakeWc();
  attachHistory(wc as any, {
    history: () => {
      throw new Error('store failed');
    },
    isShared: () => true,
  });
  wc.emit('did-navigate', {}, 'https://a.test/', 200);
  wc.emit('page-title-updated', {}, 'x');
});

test('createBrowserData: stores open once on first use, suggestions read both, clearing history keeps bookmarks', () => {
  const dir = tmp();
  const data = createBrowserData({ userData: () => dir, now: () => T0 });
  assert.equal(fs.existsSync(path.join(dir, 'browser-history.sqlite')), false, 'nothing opens until it is used');
  assert.equal(data.history(), data.history());
  assert.equal(data.bookmarks(), data.bookmarks());
  data.history().record({ url: 'https://docs.test/a', title: 'Docs' });
  data.bookmarks().toggle({ url: 'https://docs.test/b', title: 'Docs bookmark' });
  assert.deepEqual(
    data.suggest('docs').map((s: any) => s.kind),
    ['bookmark', 'history'],
  );
  assert.equal(data.suggest('docs', 1).length, 1);
  const wc = new FakeWc();
  data.attach(wc as any, () => true);
  wc.emit('did-navigate', {}, 'https://recorded.test/', 200);
  assert.equal(data.history().search({ query: 'recorded' }).length, 1);
  data.clearHistory();
  assert.equal(data.history().count(), 0);
  assert.equal(data.bookmarks().list().length, 1);
  data.history().close();
});

test('browser data IPC: sanitises input, and tells every window when bookmarks change', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (c: string, f: any) => handlers.set(c, f) };
  const dir = tmp();
  const data = createBrowserData({ userData: () => dir, now: () => T0 });
  const sent: string[] = [];
  register(ipcMain as any, { data, broadcastAll: (c: string) => sent.push(c) });
  const call = (c: string, ...a: any[]) => handlers.get(c)!({}, ...a);
  data.history().record({ url: 'https://docs.test/a', title: 'Docs' });
  assert.equal(call('browser:suggest', 'docs').length, 1);
  assert.deepEqual(call('browser:suggest', 42), []);
  call('browser:removeHistory', 'https://docs.test/a');
  call('browser:removeHistory', 7);
  assert.equal(data.history().count(), 0);
  assert.deepEqual(call('browser:toggleBookmark', { url: 'https://docs.test/b', title: 'b'.repeat(299) + '🙂tail' }), {
    bookmarked: true,
    ok: true,
  });
  assert.deepEqual(call('browser:toggleBookmark', null), { bookmarked: false, ok: false });
  assert.equal(call('browser:bookmarked', 'https://docs.test/b'), true);
  assert.equal(call('browser:bookmarked', 5), false);
  const [b] = call('browser:bookmarks');
  assert.equal(b.title, 'b'.repeat(299) + '🙂', 'IPC keeps the complete character at the title limit');
  assert.equal(call('browser:removeBookmark', 'missing'), false);
  assert.equal(call('browser:removeBookmark', b.id), true);
  assert.deepEqual(sent, ['browser:bookmarksChanged', 'browser:bookmarksChanged']);
  data.history().close();
});

test('BrowserStorage.clearAll also clears the browser history (Clear browsing data)', async () => {
  const log: string[] = [];
  const ses: any = { clearStorageData: async () => log.push('storage'), clearCache: async () => log.push('cache') };
  const storage = new BrowserStorage({ fromPartition: () => ses, clearHistory: () => log.push('history') });
  await storage.clearAll();
  assert.deepEqual(log, ['storage', 'cache', 'history']);
  const plain = new BrowserStorage({ fromPartition: () => ses });
  await plain.clearAll();
});
