// electron/migrations/2026-10-cookies.cjs: cookies the pre-rebrand app encrypted are decrypted with its
// keychain key into plaintext (backed up first), then set again so Chromium stores them with MoPilot's key; what no key opens is reported for a sign-in-again hint (D-83).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const m = require('../electron/migrations/2026-10-cookies.cjs');

const OLD = m.deriveKey('old-password');
const OTHER = m.deriveKey('someone-else');

/** A Chromium-shaped cookie database (the columns the migration reads). */
function cookieDb(file: string, version: number, rows: { host: string; name: string; value?: string; enc?: Buffer }[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)',
  );
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)');
  for (const r of rows) ins.run(r.host, r.name, r.value ?? '', r.enc ?? Buffer.alloc(0));
  db.close();
}
const rows = (file: string) =>
  new DatabaseSync(file, { readOnly: true })
    .prepare('SELECT name, value, length(encrypted_value) AS enc FROM cookies ORDER BY name')
    .all()
    .map((r) => ({ ...r }));

test('crypto: v10 values with the host hash (schema 24) and without it (older schemas)', () => {
  const blob = m.encryptValue('session=abc', OLD, '.example.test', 24);
  assert.equal(blob.subarray(0, 3).toString(), 'v10');
  assert.equal(m.decryptValue(blob, OLD, '.example.test', 24), 'session=abc');
  assert.equal(m.decryptValue(blob, OTHER, '.example.test', 24), null);
  // the hash binds the value to its host
  assert.equal(m.decryptValue(blob, OLD, '.evil.test', 24), null);
  const old = m.encryptValue('tok', OLD, 'example.test', 23);
  assert.equal(m.decryptValue(old, OLD, 'example.test', 23), 'tok');
  assert.equal(m.decryptValue(Buffer.from('plain'), OLD, 'example.test', 24), null);
});

test('migration: backs up, decrypts with the first legacy key that opens them, reports the rest', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-cookies-'));
  try {
    const browser = path.join(ud, 'Partitions', 'browser', 'Cookies');
    cookieDb(browser, 24, [
      { host: 'example.test', name: 'a', enc: m.encryptValue('one', OLD, 'example.test', 24) },
      { host: '.example.test', name: 'b', enc: m.encryptValue('two', OLD, '.example.test', 24) },
      { host: 'other.test', name: 'c', enc: m.encryptValue('lost', OTHER, 'other.test', 24) },
      { host: 'plain.test', name: 'd', value: 'kept' },
    ]);
    const before = fs.readFileSync(browser);
    const asked: string[] = [];
    const r = m.migrateCookies(ud, {
      now: Date.UTC(2026, 9, 10),
      password: (s: string) => (asked.push(s), s === 'Codex Safe Storage' ? 'old-password' : null),
    });
    assert.deepEqual(
      { result: r.result, decrypted: r.decrypted, failed: r.failed, reencrypt: r.reencrypt },
      { result: 'failed', decrypted: 2, failed: 1, reencrypt: true },
    );
    assert.deepEqual(asked, m.LEGACY_SERVICES);
    assert.deepEqual(rows(browser), [
      { name: 'a', value: 'one', enc: 0 },
      { name: 'b', value: 'two', enc: 0 },
      { name: 'c', value: '', enc: 51 },
      { name: 'd', value: 'kept', enc: 0 },
    ]);
    assert.deepEqual(fs.readFileSync(path.join(r.backup, 'Partitions', 'browser', 'Cookies')), before);
    // the copies of the cookies a sign-in rests on are owner-only (#2144)
    assert.equal(fs.statSync(path.join(r.backup, 'Partitions', 'browser', 'Cookies')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(r.backup, 'Partitions', 'browser')).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('migration: stops asking the keychain once every cookie is open; nothing encrypted asks nothing', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-cookies-'));
  try {
    cookieDb(path.join(ud, 'Network', 'Cookies'), 24, [{ host: 'x.test', name: 'a', enc: m.encryptValue('v', OLD, 'x.test', 24) }]);
    const asked: string[] = [];
    const r = m.migrateCookies(ud, { password: (s: string) => (asked.push(s), 'old-password') });
    assert.equal(r.result, 'ok');
    assert.deepEqual(asked, ['Codex Safe Storage']);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-cookies-'));
    cookieDb(path.join(fresh, 'Partitions', 'browser', 'Cookies'), 24, []);
    const none = m.migrateCookies(fresh, { password: () => assert.fail('no keychain read without encrypted cookies') });
    assert.deepEqual(
      { result: none.result, reencrypt: none.reencrypt, backup: none.backup },
      { result: 'none', reencrypt: false, backup: null },
    );
    fs.rmSync(fresh, { recursive: true, force: true });
  } finally {
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('re-encrypt: every cookie is set again as it was', async () => {
  const got = [
    {
      name: 'a',
      value: '1',
      domain: 'example.test',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      expirationDate: 2e9,
    },
    {
      name: 'b',
      value: '2',
      domain: '.example.test',
      hostOnly: false,
      path: '/app',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      session: true,
    },
  ];
  const set: any[] = [];
  let flushed = false;
  const ses = { cookies: { get: async () => got, set: async (d: any) => void set.push(d), flushStore: async () => void (flushed = true) } };
  assert.equal(await m.reencryptSession(ses), 2);
  assert.ok(flushed);
  assert.deepEqual(set, [
    { url: 'https://example.test/', name: 'a', value: '1', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2e9 },
    {
      url: 'http://example.test/app',
      name: 'b',
      value: '2',
      domain: '.example.test',
      path: '/app',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
    },
  ]);
});

test('a cookie Chromium will not store again is removed, never left in plain text (#2144)', async () => {
  const got = [
    { name: 'ok', value: '1', domain: 'example.test', hostOnly: true, path: '/', secure: true, session: true },
    { name: 'bad', value: '2', domain: 'example.test', hostOnly: true, path: '/', secure: true, session: true },
  ];
  const removed: any[] = [];
  let removeFails = false;
  const ses = {
    cookies: {
      get: async () => got,
      set: async (d: any) => {
        if (d.name === 'bad') throw new Error('expired');
      },
      remove: async (url: string, name: string) => {
        if (removeFails) throw new Error('gone');
        removed.push([url, name]);
      },
      flushStore: async () => {},
    },
  };
  assert.equal(await m.reencryptSession(ses), 1);
  assert.deepEqual(removed, [['https://example.test/', 'bad']]);
  removeFails = true;
  assert.equal(await m.reencryptSession(ses), 1, 'a cookie that can not be removed either is left to Chromium');
});

test('scrubbing rewrites every cookie database so the plaintext of step 1 is gone from its free pages (#2144)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-scrub-'));
  const file = path.join(ud, 'Cookies');
  cookieDb(file, 24, [{ host: 'example.test', name: 'sid', value: 'PLAINTEXT-SECRET-'.repeat(50) }]);
  const db = new DatabaseSync(file);
  db.exec("UPDATE cookies SET value = '', encrypted_value = X'763130' WHERE name = 'sid'");
  db.close();
  assert.ok(fs.readFileSync(file).includes('PLAINTEXT-SECRET-'), 'the old value is still in a free page');
  // a cookie still stored in plain text (Chromium would not take it again) goes too
  const still = new DatabaseSync(file);
  still.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('example.test', 'left', 'STILL-PLAIN-VALUE', Buffer.alloc(0));
  still.close();
  const backup = path.join(ud, 'backups', 'cookies-20261023T000000Z');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'Cookies'), 'old-key cookies');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-backup-'));
  assert.equal(m.scrubDbs(ud, elsewhere), 1);
  assert.ok(fs.existsSync(elsewhere), 'only a folder in the app’s own backups is ever removed');
  assert.ok(!fs.readFileSync(file).includes('PLAINTEXT-SECRET-'));
  assert.ok(!fs.readFileSync(file).includes('STILL-PLAIN-VALUE'));
  assert.deepEqual(rows(file), [{ name: 'sid', value: '', enc: 3 }]);
  assert.equal(m.scrubDbs(ud, backup), 0);
  assert.equal(fs.existsSync(backup), false, 'the backup goes once the scrub is done');
  assert.equal(m.scrubDbs(fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-none-'))), 0);
});

test('a refused cookie that shares its name and domain, or is partitioned, is not removed (it would take the other) (#2144)', async () => {
  const got = [
    { name: 'sid', value: '1', domain: 'example.test', hostOnly: true, path: '/', secure: true, session: true },
    { name: 'sid', value: '2', domain: 'example.test', hostOnly: true, path: '/app', secure: true, session: true },
    {
      name: 'chips',
      value: '3',
      domain: 'example.test',
      hostOnly: true,
      path: '/',
      secure: true,
      session: true,
      partitionKey: { topLevelSite: 'https://top.test' },
    },
  ];
  const removed: any[] = [];
  const ses = {
    cookies: {
      get: async () => got,
      set: async (d: any) => {
        if (d.path === '/app' || d.name === 'chips') throw new Error('refused');
      },
      remove: async (...a: any[]) => void removed.push(a),
      flushStore: async () => {},
    },
  };
  assert.equal(await m.reencryptSession(ses), 1);
  assert.deepEqual(removed, []);
});
