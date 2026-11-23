// The built-in browser's history at rest (#2144): kept in memory while the app runs and saved sealed
// (historyStore.cjs + sealedFile.cjs); an earlier version's plain database is moved in and deleted; without the OS key
// nothing is written; a sealed history another key made is never saved over; changes are saved a little later, at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { HistoryStore } = require('../electron/capabilities/browser/historyStore.cjs');
const { SealedFile } = require('../electron/platform/sealedFile.cjs');
const { createBrowserData } = require('../electron/capabilities/browser/data.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { DatabaseSync } = require('node:sqlite');

const T0 = Date.UTC(2026, 9, 23);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'history-at-rest-'));
const contexts = () => recentIgnored().map((e: any) => e.context);
const make = (dir: string, extra: any = {}) =>
  new HistoryStore({ file: path.join(dir, 'browser-history.sqlite'), now: () => T0, safeStorage: fakeSafe(), ...extra });

test('history is saved sealed and private, readable again, with no plain database on disk', () => {
  const dir = tmp();
  const store = make(dir);
  store.record({ url: 'https://private.example/page', title: 'Private page' });
  store.close();
  const sealed = path.join(dir, 'browser-history.sqlite.enc');
  assert.equal(fs.statSync(sealed).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'browser-history.key')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(sealed).includes('private.example'));
  assert.equal(fs.existsSync(path.join(dir, 'browser-history.sqlite')), false);
  const again = make(dir);
  assert.equal(again.search({ query: 'private' })[0].title, 'Private page');
  again.close();
});

test('an earlier version’s plain database (WAL mode) is moved in, saved sealed, and deleted with its journal', () => {
  const dir = tmp();
  const file = path.join(dir, 'browser-history.sqlite');
  const old = new DatabaseSync(file);
  old.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE urls (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'local')",
  );
  old.prepare('INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, 1, ?)').run('https://old.example/', 'Old', T0);
  assert.ok(fs.existsSync(`${file}-wal`), 'the row is still in the journal');
  const store = make(dir);
  assert.equal(store.search({ query: 'old.example' })[0].title, 'Old');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) assert.equal(fs.existsSync(f), false, f);
  old.close();
  store.close();
  assert.equal(make(dir).search({ query: 'old.example' })[0].title, 'Old');
});

test('without the OS key history is kept for this run only: nothing is written, a plain one is read and left', () => {
  const dir = tmp();
  const file = path.join(dir, 'browser-history.sqlite');
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE urls (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'local')",
  );
  old.close();
  const before = fs.readFileSync(file);
  clearIgnored();
  const store = make(dir, { safeStorage: fakeSafe(false) });
  store.record({ url: 'https://run.example/', title: 'Run' });
  assert.equal(store.search({ query: 'run.example' }).length, 1);
  store.close();
  assert.deepEqual(fs.readFileSync(file), before, 'the plain one is left as it was, never written');
  assert.equal(fs.existsSync(`${file}.enc`), false);
  assert.ok(contexts().includes('save the browser history'));
});

test('a sealed history another OS key made turns history off and is never saved over', () => {
  const dir = tmp();
  const first = make(dir);
  first.record({ url: 'https://kept.example/' });
  first.close();
  const sealed = fs.readFileSync(path.join(dir, 'browser-history.sqlite.enc'));
  const other = {
    ...fakeSafe(),
    decryptString: () => {
      throw new Error('another key');
    },
  };
  clearIgnored();
  const store = make(dir, { safeStorage: other });
  assert.equal(store.record({ url: 'https://new.example/' }), false);
  assert.deepEqual(store.search({ query: 'kept' }), []);
  store.close();
  assert.deepEqual(fs.readFileSync(path.join(dir, 'browser-history.sqlite.enc')), sealed);
  assert.deepEqual(contexts(), ['open the browser history database']);
});

test('changes are saved once, a little after they happen, and every kind of change counts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = tmp();
  const store = make(dir, { saveMs: 1000 });
  const sealed = path.join(dir, 'browser-history.sqlite.enc');
  store.record({ url: 'https://a.example/' });
  store.setTitle('https://a.example/', 'A');
  assert.equal(fs.existsSync(sealed), false, 'not yet');
  t.mock.timers.tick(1000);
  assert.equal(fs.existsSync(sealed), true);
  const saves = () => fs.statSync(sealed).mtimeMs;
  for (const change of [
    () => store.importVisits([{ url: 'https://b.example/', lastVisit: T0 }], 'chrome'),
    () => store.deleteImported('chrome'),
    () => store.remove('https://a.example/'),
    () => store.clear(),
  ]) {
    fs.utimesSync(sealed, 1, 1);
    change();
    t.mock.timers.tick(1000);
    assert.notEqual(saves(), 1000, String(change));
  }
  // nothing changed: nothing is written
  fs.utimesSync(sealed, 1, 1);
  store.flush();
  assert.equal(saves(), 1000);
  store.close();
});

test('the browser data service closes the history (saved) at quit, and does nothing when it never opened', () => {
  const dir = tmp();
  const data = createBrowserData({ userData: () => dir, now: () => T0, safeStorage: fakeSafe() });
  data.close();
  data.history().record({ url: 'https://quit.example/' });
  data.close();
  assert.ok(fs.existsSync(path.join(dir, 'browser-history.sqlite.enc')));
});

test('SealedFile: none, not one of its files, a missing key, and the OS key refusing', () => {
  const dir = tmp();
  const f = (extra: any = {}) =>
    new SealedFile({ file: path.join(dir, 'x.enc'), keyFile: path.join(dir, 'x.key'), safeStorage: fakeSafe(), what: 'x', ...extra });
  assert.equal(f().read(), null);
  assert.equal(f().available(), true);
  fs.writeFileSync(path.join(dir, 'x.enc'), 'plain text');
  assert.throws(() => f().read(), /x is not a sealed file/);
  f().write(Buffer.from('hello'));
  assert.equal(f().read().toString(), 'hello');
  fs.rmSync(path.join(dir, 'x.key'));
  assert.throws(() => f().read(), /the key of x is missing/);
  assert.throws(
    () => f({ safeStorage: fakeSafe(false) }).write(Buffer.from('y')),
    (e: any) => e.code === 'secret_unavailable',
  );
  assert.equal(f({ safeStorage: null }).available(), false);
  // a sealed path that can't be read (a folder there) throws, never reads as none
  const folder = path.join(dir, 'folder.enc');
  fs.mkdirSync(folder);
  assert.throws(() => f({ file: folder }).read(), /EISDIR/);
});

test('clearing browsing data clears a history that can’t be opened, so history works again; nothing is recorded after quit', () => {
  const dir = tmp();
  const first = make(dir);
  first.record({ url: 'https://lost.example/' });
  first.close();
  assert.equal(first.record({ url: 'https://after-quit.example/' }), false, 'after quit nothing is recorded');
  const other = {
    ...fakeSafe(),
    decryptString: () => {
      throw new Error('another key');
    },
  };
  const store = make(dir, { safeStorage: other });
  assert.deepEqual(store.search({ query: 'lost' }), []);
  store.clear();
  assert.equal(fs.existsSync(path.join(dir, 'browser-history.sqlite.enc')), false);
  assert.equal(fs.existsSync(path.join(dir, 'browser-history.key')), false);
  // with a working key again, the next use starts afresh
  store.sealed.safe = fakeSafe();
  assert.equal(store.record({ url: 'https://fresh.example/' }), true);
  store.close();
  assert.equal(make(dir).search({ query: 'fresh' }).length, 1);
});

test('a sealed file is on the disk, with its folder, before the plain one it replaces is deleted', (t) => {
  const dir = tmp();
  const synced = t.mock.method(fs, 'fsyncSync');
  new SealedFile({ file: path.join(dir, 'x.enc'), keyFile: path.join(dir, 'x.key'), safeStorage: fakeSafe(), what: 'x' }).write(
    Buffer.from('a'),
  );
  // the file and its folder (the key file is a plain private write)
  assert.equal(synced.mock.callCount(), 2);
});

/** A plain history database as an earlier version (or one run since a downgrade) writes it. */
function plainHistory(file: string, rows: [string, string, number, number][]) {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE IF NOT EXISTS urls (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'local')",
  );
  for (const [url, title, visits, at] of rows)
    db.prepare('INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, ?, ?)').run(url, title, visits, at);
  db.close();
}

test('a plain history beside the sealed one (a crash, a downgrade) is merged in and deleted at once', () => {
  const dir = tmp();
  const sealedFirst = make(dir);
  sealedFirst.record({ url: 'https://both.example/', title: 'Old title', at: T0 - 1000 });
  sealedFirst.record({ url: 'https://sealed-only.example/', title: 'Sealed' });
  sealedFirst.close();
  const file = path.join(dir, 'browser-history.sqlite');
  plainHistory(file, [
    ['https://both.example/', 'Newer title', 5, T0],
    ['https://plain-only.example/', 'Plain', 1, T0],
  ]);
  const store = make(dir);
  assert.equal(store.search({ query: 'plain-only' })[0].title, 'Plain');
  assert.equal(store.search({ query: 'sealed-only' })[0].title, 'Sealed');
  const both = store.search({ query: 'both.example' })[0];
  assert.deepEqual([both.title, both.visitCount, both.lastVisit], ['Newer title', 5, T0]);
  assert.equal(fs.existsSync(file), false, 'deleted at once, not at the next change');
  store.close();
  assert.equal(make(dir).search({ query: 'plain-only' }).length, 1);
});

test('a plain history that can’t be merged is left where it is, and history still works', () => {
  const dir = tmp();
  const first = make(dir);
  first.record({ url: 'https://kept.example/' });
  first.close();
  const file = path.join(dir, 'browser-history.sqlite');
  const odd = new DatabaseSync(file);
  odd.exec('CREATE TABLE something_else (x)');
  odd.close();
  clearIgnored();
  const store = make(dir);
  assert.equal(store.search({ query: 'kept' }).length, 1);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(contexts(), ['merge an older plain browser history']);
  store.close();
});

test('clearing browsing data saves at once, with the cleared pages gone from the sealed file too', () => {
  const dir = tmp();
  const store = make(dir, { saveMs: 3_600_000 });
  for (let i = 0; i < 200; i++) store.record({ url: `https://cleared-${i}.example/`, title: 'x'.repeat(200) });
  store.flush();
  const before = fs.statSync(path.join(dir, 'browser-history.sqlite.enc')).size;
  store.clear();
  // saved now (no timer has run), and VACUUMed: a much smaller file with nothing of the cleared pages
  const sealed = path.join(dir, 'browser-history.sqlite.enc');
  assert.ok(fs.statSync(sealed).size < before / 4, `${fs.statSync(sealed).size} vs ${before}`);
  const reopened = make(dir);
  assert.equal(reopened.count(), 0);
  // the sealed bytes themselves hold none of the cleared pages, free pages included
  const opened = new SealedFile({
    file: sealed,
    keyFile: path.join(dir, 'browser-history.key'),
    safeStorage: fakeSafe(),
    what: 'h',
  }).read();
  assert.ok(!opened.includes('cleared-'));
  store.close();
  reopened.close();
});

test('history title limits preserve Unicode through record, update, import and a sealed reopen', () => {
  const dir = tmp();
  const store = make(dir);
  const title = 'x'.repeat(299) + '🙂' + 'tail';
  const expected = 'x'.repeat(299) + '🙂';
  store.record({ url: 'https://record.test/', title });
  assert.equal(store.search({ query: 'record.test' })[0].title, expected);
  store.setTitle('https://record.test/', 'y'.repeat(299) + '🙂tail');
  assert.equal(store.search({ query: 'record.test' })[0].title, 'y'.repeat(299) + '🙂');
  store.importVisits([{ url: 'https://import.test/', title, lastVisit: T0 }], 'chrome');
  assert.equal(store.search({ query: 'import.test' })[0].title, expected);
  store.close();
  const reopened = make(dir);
  assert.equal(reopened.search({ query: 'record.test' })[0].title, 'y'.repeat(299) + '🙂');
  reopened.close();
});
