// Computer History's store (#1363, electron/computerHistory/store.cjs): encrypted day files only this user can read, nothing in plain text without encryption, unreadable settings read as off and are kept, unreadable lines counted and kept, retention and deletes by whole day.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HistoryStore, StoreError } = require('../electron/computerHistory/store.cjs');
const { DEFAULT_SETTINGS } = require('../electron/computerHistory/policy.cjs');
const { newestDayFirst } = require('../electron/computerHistory/segments.cjs');
import { fakeSafe } from './support/computerHistory.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-'));
  dirs.push(d);
  return path.join(d, 'computer-history');
};
const at = (h: number, day = 18) => new Date(2026, 9, day, h).getTime();
const entry = (over = {}) => ({
  bundleId: 'com.apple.Notes',
  app: 'Notes',
  title: 'Secret plan',
  start: at(10),
  end: at(10) + 5000,
  ...over,
});
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('settings are off by default, saved 0600 in a 0700 folder, and read back', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  assert.deepEqual(s.readSettings(), DEFAULT_SETTINGS);
  assert.equal(s.settingsError, null);
  const saved = s.writeSettings({ ...DEFAULT_SETTINGS, enabled: true, sites: ['Example.com'] });
  assert.deepEqual(saved.sites, ['example.com']);
  assert.equal(mode(s.settingsFile), 0o600);
  assert.equal(mode(s.dir), 0o700);
  assert.deepEqual(s.readSettings(), saved);
});

test('unreadable settings read as off, are kept aside and not saved over until the user changes a setting', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"enabled": true, ');
  const s = new HistoryStore({ dir, safeStorage: fakeSafe() });
  assert.deepEqual(s.readSettings(), DEFAULT_SETTINGS);
  assert.ok(s.settingsError);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"enabled": true, ', 'the file is not touched by reading');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.unreadable')));
  s.writeSettings({ ...DEFAULT_SETTINGS, enabled: true });
  assert.equal(s.settingsError, null);
});

test('entries are written encrypted, one line each, and read back by day', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  s.append([entry(), entry({ title: 'Next', start: at(11), end: at(11) + 5000 }), entry({ start: at(9, 19), end: at(9, 19) + 1 })]);
  s.append([]);
  const file = path.join(s.days, '2026-10-18.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('Secret plan') && !raw.includes('Notes'), 'no plain text on disk');
  assert.equal(raw.trim().split('\n').length, 2);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(s.days), 0o700);
  assert.deepEqual(
    s.readDay('2026-10-18').entries.map((e: { title: string }) => e.title),
    ['Secret plan', 'Next'],
  );
  assert.equal(s.readDay('2026-10-19').entries.length, 1);
  assert.deepEqual(s.readDay('2026-10-20'), { entries: [], unreadable: 0 });
  assert.deepEqual(s.listDays(), ['2026-10-19', '2026-10-18']);
});

test('without encryption nothing is written, not even the entries that could be encrypted', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe(false) });
  assert.equal(s.canWrite(), false);
  assert.throws(
    () => s.append([entry()]),
    (e: InstanceType<typeof StoreError>) => e.code === 'store_unavailable',
  );
  assert.equal(fs.existsSync(s.days), false);
  const none = new HistoryStore({ dir: tmp(), safeStorage: null });
  assert.equal(none.canWrite(), false);
  assert.throws(() => none.append([entry()]), /could not encrypt/);
  const broken = new HistoryStore({
    dir: tmp(),
    safeStorage: {
      ...fakeSafe(),
      isEncryptionAvailable: () => {
        throw new Error('keychain gone');
      },
    },
  });
  assert.equal(broken.canWrite(), false);
  assert.ok(new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() }).canWrite());
});

test('lines that cannot be decrypted or read are counted and stay in the file', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  s.append([entry()]);
  const file = path.join(s.days, '2026-10-18.jsonl');
  const bad = Buffer.from(`enc:${Buffer.from('{"not":"an entry"}').toString('hex')}`).toString('base64');
  fs.appendFileSync(file, `garbage\n${bad}\n\n`);
  const r = s.readDay('2026-10-18');
  assert.equal(r.entries.length, 1);
  assert.equal(r.unreadable, 2);
  assert.ok(fs.readFileSync(file, 'utf8').includes('garbage'));
});

test('a read that fails for another reason than a missing file is reported', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  fs.mkdirSync(path.join(s.days, '2026-10-18.jsonl'), { recursive: true });
  assert.throws(() => s.readDay('2026-10-18'), /EISDIR/);
  const notDir = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  fs.mkdirSync(notDir.dir, { recursive: true });
  fs.writeFileSync(notDir.days, 'a file where the folder goes');
  assert.throws(() => notDir.listDays(), /ENOTDIR/);
});

test('days are only real day keys: a path or junk name is refused, other files are ignored', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  assert.deepEqual(s.listDays(), []);
  for (const bad of ['../settings', '2026-02-30', '', 7])
    assert.throws(
      () => s.deleteDay(bad),
      (e: InstanceType<typeof StoreError>) => e.code === 'invalid_day',
    );
  assert.throws(() => s.readDay('../../x'), /Not a day/);
  s.append([entry()]);
  fs.writeFileSync(path.join(s.days, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(s.days, '2026-13-01.jsonl'), 'x');
  assert.deepEqual(s.listDays(), ['2026-10-18']);
});

test('retention keeps today and the days before it, and deletes remove whole days', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  for (const d of [1, 10, 11, 17, 18]) s.append([entry({ start: at(10, d), end: at(10, d) + 1 })]);
  assert.deepEqual(s.prune(7, at(12, 17)), ['2026-10-10', '2026-10-01'], 'the 11th is the 7th day back');
  assert.deepEqual(s.listDays(), ['2026-10-18', '2026-10-17', '2026-10-11']);
  s.deleteDay('2026-10-17');
  s.deleteDay('2026-10-16');
  assert.deepEqual(s.listDays(), ['2026-10-18', '2026-10-11']);
  s.writeSettings({ ...DEFAULT_SETTINGS, enabled: true });
  s.deleteAll();
  assert.deepEqual(s.listDays(), []);
  assert.equal(s.readSettings().enabled, true, 'the settings stay');
});

test('days sort newest first, across months and years', () => {
  assert.deepEqual(['2026-09-30', '2026-10-01', '2025-12-31', '2026-10-01'].sort(newestDayFirst), [
    '2026-10-01',
    '2026-10-01',
    '2026-09-30',
    '2025-12-31',
  ]);
  assert.equal(newestDayFirst('2026-10-01', '2026-10-01'), 0);
});

test('W2: a day that cannot be written is named in the error; the days written stay written once', () => {
  const s = new HistoryStore({ dir: tmp(), safeStorage: fakeSafe() });
  fs.mkdirSync(path.join(s.days, '2026-10-19.jsonl'), { recursive: true });
  const late = entry({ title: 'late', start: at(9, 19), end: at(9, 19) + 1 });
  assert.throws(
    () => s.append([entry(), late]),
    (e: InstanceType<typeof StoreError>) =>
      e.code === 'store_unavailable' && e.unwritten?.length === 1 && e.unwritten[0] === late && /EISDIR/.test(e.message),
  );
  assert.equal(s.readDay('2026-10-18').entries.length, 1);
});
