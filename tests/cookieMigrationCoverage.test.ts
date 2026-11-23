// electron/migrations/2026-10-cookies.cjs edge cases: the keychain read (faked `security`), databases
// without a schema version, values that decrypt to control characters, and cookies that won't set.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const securityCalls: any[] = [];
let keychain: Record<string, string> = {};
mock.module('node:child_process', {
  namedExports: {
    execFileSync: (cmd: string, args: string[], o: any) => {
      securityCalls.push([cmd, args, o.encoding]);
      const service = args[args.length - 1];
      if (!(service in keychain)) throw new Error('The specified item could not be found in the keychain.');
      return `${keychain[service]}\n`;
    },
  },
});
const m = createRequire(import.meta.url)('../electron/migrations/2026-10-cookies.cjs');

const KEY = m.deriveKey('old-pw');

test('decryptValue: no blob, and a value with control characters is rejected as a wrong key', () => {
  assert.equal(m.decryptValue(undefined, KEY, 'h', 23), null);
  const bad = m.encryptValue('a\u0001b', KEY, 'h', 23);
  assert.equal(m.decryptValue(bad, KEY, 'h', 23), null);
});

test('without a meta version the database is read as the oldest schema; the keychain is read with security', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cookcov-'));
  const file = path.join(ud, 'Cookies');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)',
  );
  db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('h.test', 'a', '', m.encryptValue('v', KEY, 'h.test', 0));
  db.close();
  assert.deepEqual(m.survey(file), { version: 0, encrypted: 1, plain: 0 });

  keychain = { 'Sage Codex Safe Storage': 'old-pw' };
  const r = m.migrateCookies(ud, { now: Date.UTC(2026, 9, 10) });
  assert.deepEqual({ result: r.result, decrypted: r.decrypted, failed: r.failed }, { result: 'ok', decrypted: 1, failed: 0 });
  assert.deepEqual(
    securityCalls.map((c) => c[1]),
    [
      ['find-generic-password', '-w', '-s', 'Codex Safe Storage'],
      ['find-generic-password', '-w', '-s', 'Sage Codex Safe Storage'],
    ],
  );
  assert.equal(securityCalls[0][0], 'security');
  const row: any = new DatabaseSync(file, { readOnly: true }).prepare('SELECT value FROM cookies').get();
  assert.equal(row.value, 'v');
});

test('setDetails: a cookie without a domain or path', () => {
  assert.deepEqual(m.setDetails({ name: 'n', value: 'v', hostOnly: true, secure: false, httpOnly: false, session: true }), {
    url: 'http:///',
    name: 'n',
    value: 'v',
    path: undefined,
    secure: false,
    httpOnly: false,
  });
});

test('reencryptSession removes a cookie Chromium refuses (it was stored in plain text) and still flushes', async () => {
  const set: string[] = [];
  const removed: string[] = [];
  let flushed = false;
  const ses = {
    cookies: {
      get: async () => [
        { name: 'bad', domain: 'x', path: '/' },
        { name: 'good', domain: 'x', path: '/' },
      ],
      set: async (d: any) => {
        if (d.name === 'bad') throw new Error('invalid');
        set.push(d.name);
      },
      remove: async (_url: string, name: string) => void removed.push(name),
      flushStore: async () => {
        flushed = true;
      },
    },
  };
  assert.equal(await m.reencryptSession(ses), 1);
  assert.deepEqual(set, ['good']);
  assert.deepEqual(removed, ['bad']);
  assert.equal(flushed, true);
});
