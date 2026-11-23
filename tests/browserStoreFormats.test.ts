// Version ownership and preservation at the bookmark/import-ledger JSON write boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BookmarkStore } = require('../electron/capabilities/browser/bookmarkStore.cjs');
const { ImportLedger } = require('../electron/capabilities/browser/import/cookies.cjs');
const bookmark = { id: 'a', title: 'A', url: 'https://a.test/', folderPath: [], addedAt: 1, source: 'import:chrome' };
const cookie = { host: 'a.test', name: 'sid', path: '/', secure: true };
const entry = { source: 'chrome', importedAt: 1, entries: [['a.test', 'sid', '/', true]] };
function file(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-store-format-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'saved.json');
}
const bookmarkMutations = {
  toggle: (store: any) => store.toggle({ url: 'https://new.test/' }),
  remove: (store: any) => store.remove('a'),
  import: (store: any) => store.importItems([{ url: 'https://new.test/' }], 'Chrome', 'chrome'),
  deleteImported: (store: any) => store.deleteImported('chrome'),
  clear: (store: any) => store.clear(),
};
for (const [name, mutate] of Object.entries(bookmarkMutations)) {
  test(`bookmark ${name} preserves newer-version data`, (t) => {
    const target = file(t);
    const original = JSON.stringify({ version: 2, items: [bookmark], future: { retained: true } });
    fs.writeFileSync(target, original);
    const store = new BookmarkStore({ file: target });
    assert.equal(store.list().length, 1);
    assert.throws(() => mutate(store), /newer version/i);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(store.list().length, 1);
  });
}
for (const version of [null, 0, -1, 1.5, '1', true]) {
  test(`both browser stores protect unsupported declaration ${JSON.stringify(version)}`, async (t) => {
    const target = file(t);
    const original = JSON.stringify({ version, items: [bookmark], cookies: { 'a.test': entry }, last: null });
    fs.writeFileSync(target, original);
    assert.throws(() => new BookmarkStore({ file: target }).clear(), /unsupported/i);
    assert.throws(() => new ImportLedger({ file: target }).recordLast({ source: 'new' }), /unsupported/i);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  });
}
for (const method of ['recordCookies', 'recordLast', 'remove']) {
  test(`ledger ${method} preserves newer-version data before changing memory or session cookies`, async (t) => {
    const target = file(t);
    const original = JSON.stringify({ version: 2, cookies: { 'a.test': entry }, last: { source: 'chrome' }, future: ['keep'] });
    fs.writeFileSync(target, original);
    const store = new ImportLedger({ file: target });
    const before = store.sites();
    let effects = 0;
    if (method === 'remove')
      await assert.rejects(
        store.remove({ cookies: { remove: async () => effects++, flushStore: async () => effects++ } }),
        /newer version/i,
      );
    else if (method === 'recordCookies') assert.throws(() => store.recordCookies('new', [cookie], () => 'a.test'), /newer version/i);
    else assert.throws(() => store.recordLast({ source: 'new' }), /newer version/i);
    assert.equal(effects, 0);
    assert.deepEqual(store.sites(), before);
    assert.deepEqual(store.last(), { source: 'chrome' });
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  });
}
for (const original of ['null', 'true', '[]', '"primitive"', '{torn']) {
  test(`unreadable browser JSON root ${original} stays preserved before mutations`, async (t) => {
    const target = file(t);
    fs.writeFileSync(target, original);
    assert.throws(() => new BookmarkStore({ file: target }).toggle({ url: 'https://new.test/' }), /saved bookmarks/i);
    assert.throws(() => new ImportLedger({ file: target }).recordLast({ source: 'new' }), /import ledger/i);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.readFileSync(`${target}.unreadable`, 'utf8'), original);
  });
}

for (const data of [{ items: [] }, { version: 1, items: [] }]) {
  test(`legacy/current bookmark format stays writable ${JSON.stringify(data)}`, (t) => {
    const target = file(t);
    fs.writeFileSync(target, JSON.stringify(data));
    const store = new BookmarkStore({ file: target });
    assert.equal(store.toggle({ url: 'https://new.test/' }).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 1);
  });
}
for (const data of [{}, { cookies: {} }, { version: 1, cookies: {} }]) {
  test(`legacy/current import ledger stays writable ${JSON.stringify(data)}`, (t) => {
    const target = file(t);
    fs.writeFileSync(target, JSON.stringify(data));
    const store = new ImportLedger({ file: target });
    store.recordCookies('chrome', [cookie], () => 'a.test');
    store.recordLast({ source: 'chrome' });
    assert.equal(store.sites()[0].count, 1);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 1);
  });
}
const badEntries = [
  null,
  {},
  { ...entry, source: 1 },
  { ...entry, importedAt: '1' },
  { ...entry, entries: {} },
  { ...entry, entries: [null] },
  { ...entry, entries: [[]] },
  { ...entry, entries: [[1, 'sid', '/', true]] },
  { ...entry, entries: [['a.test', 1, '/', true]] },
  { ...entry, entries: [['a.test', 'sid', 1, true]] },
  { ...entry, entries: [['a.test', 'sid', '/', 1]] },
];
for (const bad of badEntries) {
  test(`malformed ledger cleanup entry is preserved ${JSON.stringify(bad)}`, (t) => {
    const target = file(t);
    const original = JSON.stringify({ version: 1, cookies: { 'a.test': bad } });
    fs.writeFileSync(target, original);
    const store = new ImportLedger({ file: target });
    assert.deepEqual(store.sites(), []);
    assert.throws(() => store.recordLast({ source: 'new' }), /import ledger.*could not be read/i);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.readFileSync(`${target}.unreadable`, 'utf8'), original);
  });
}

test('known malformed bookmark collections retain a backup before an explicit clear recovers them', (t) => {
  const target = file(t);
  const original = JSON.stringify({ version: 1, items: {} });
  fs.writeFileSync(target, original);
  const store = new BookmarkStore({ file: target });
  assert.throws(() => store.toggle({ url: 'https://new.test/' }), /saved bookmarks/i);
  assert.equal(fs.readFileSync(`${target}.unreadable`, 'utf8'), original);
  store.clear();
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).items, []);
  assert.equal(fs.readFileSync(`${target}.unreadable`, 'utf8'), original);
});

test('unknown format collections stay read-only even when no compatible fields can be shown', (t) => {
  const target = file(t);
  const original = JSON.stringify({ version: 2, items: {}, cookies: [], future: true });
  fs.writeFileSync(target, original);
  const bookmarks = new BookmarkStore({ file: target });
  assert.deepEqual(bookmarks.list(), []);
  assert.throws(() => bookmarks.clear(), /newer version/i);
  const ledger = new ImportLedger({ file: target });
  assert.deepEqual(ledger.sites(), []);
  assert.throws(() => ledger.recordLast({ source: 'new' }), /newer version/i);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});
