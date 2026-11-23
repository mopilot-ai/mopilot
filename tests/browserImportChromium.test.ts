// Reading a Chromium profile for import: bookmarks, history and cookies from real fixture files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromiumTime, readBookmarks, readHistory, readCookies } = require('../electron/capabilities/browser/import/chromium.cjs');
const { deriveKey, encryptValue } = require('../shared/chromiumCrypto.cjs');

const EPOCH_DELTA_MS = 11644473600000;
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const key = deriveKey('right password');
const wrongKey = deriveKey('wrong password');
/** Chromium time in microseconds since 1601, as a BigInt (it does not fit a double exactly). */
const cr = (unixMs: number) => BigInt(unixMs + EPOCH_DELTA_MS) * 1000n;

const profile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'import-chromium-test-'));

test('chromiumTime: converts, and is null for absent, zero or unparsable values', () => {
  assert.equal(chromiumTime(String(cr(NOW))), NOW);
  assert.equal(chromiumTime(cr(NOW)), NOW);
  assert.equal(chromiumTime(Number(cr(NOW))), NOW);
  for (const bad of [undefined, null, '', '0', 0, 'abc', 1.5]) assert.equal(chromiumTime(bad as any), null, String(bad));
});

// ---- bookmarks ----

const node = (name: string, url: string, extra = {}) => ({ type: 'url', name, url, ...extra });
const folder = (name: string, children: unknown[]) => ({ type: 'folder', name, children });

test('readBookmarks: walks the three roots, nests folders, keeps only http(s) urls and converts dates', async () => {
  const dir = profile();
  fs.writeFileSync(
    path.join(dir, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: folder('Bookmarks bar', [
          node('A', 'https://a.example/', { date_added: String(cr(NOW)) }),
          folder('Work', [
            node('B', 'http://b.example/', { date_added: '0' }),
            folder('Deep', [node('C', 'HTTPS://c.example/', { date_added: 'junk' })]),
          ]),
          node('JS', 'javascript:alert(1)'),
          node('File', 'file:///etc/hosts'),
          node('No url', undefined as any),
          { type: 'url', url: 'https://noname.example/' },
          { type: 'separator' },
          null,
          { type: 'folder', children: [node('Unnamed folder', 'https://u.example/')] },
          { type: 'folder', name: 'Empty' },
        ]),
        other: folder('Other bookmarks', [node('D', 'https://d.example/')]),
        synced: folder('Mobile bookmarks', [node('E', 'https://e.example/')]),
      },
    }),
  );
  const out = await readBookmarks(dir);
  assert.deepEqual(out, [
    { title: 'A', url: 'https://a.example/', folderPath: ['Bookmarks bar'], addedAt: NOW },
    { title: 'B', url: 'http://b.example/', folderPath: ['Bookmarks bar', 'Work'], addedAt: null },
    { title: 'C', url: 'HTTPS://c.example/', folderPath: ['Bookmarks bar', 'Work', 'Deep'], addedAt: null },
    { title: '', url: 'https://noname.example/', folderPath: ['Bookmarks bar'], addedAt: null },
    { title: 'Unnamed folder', url: 'https://u.example/', folderPath: ['Bookmarks bar', ''], addedAt: null },
    { title: 'D', url: 'https://d.example/', folderPath: ['Other bookmarks'], addedAt: null },
    { title: 'E', url: 'https://e.example/', folderPath: ['Mobile bookmarks'], addedAt: null },
  ]);
});

test('readBookmarks: missing roots, no bookmark file and malformed JSON', async () => {
  const dir = profile();
  // Chromium writes no bookmark file until a bookmark exists: that profile has none, it did not fail
  assert.deepEqual(await readBookmarks(dir), []);
  fs.writeFileSync(path.join(dir, 'Bookmarks'), '{"roots":{"other":{"children":"x"}}}');
  assert.deepEqual(await readBookmarks(dir), []);
  fs.writeFileSync(path.join(dir, 'Bookmarks'), 'null');
  assert.deepEqual(await readBookmarks(dir), []);
  fs.writeFileSync(path.join(dir, 'Bookmarks'), '{not json');
  await assert.rejects(readBookmarks(dir), (e: any) => e.code === 'read_failed' && e.name === 'ImportError');
  // a JSON that nests deeper than the walker can follow is a failed read, not a crash
  const deep = '{"type":"folder","children":['.repeat(20000);
  fs.writeFileSync(path.join(dir, 'Bookmarks'), `{"roots":{"other":${deep}}}`);
  await assert.rejects(readBookmarks(dir), (e: any) => e.code === 'read_failed');
});

test('readBookmarks: reads AccountBookmarks when a signed-in profile has no Bookmarks file', async () => {
  const dir = profile();
  fs.writeFileSync(
    path.join(dir, 'AccountBookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: folder('Bookmarks bar', [node('A', 'https://a.example/')]),
        synced: folder('Mobile', [node('M', 'https://m.example/')]),
      },
    }),
  );
  assert.deepEqual(await readBookmarks(dir), [
    { title: 'A', url: 'https://a.example/', folderPath: ['Bookmarks bar'], addedAt: null },
    { title: 'M', url: 'https://m.example/', folderPath: ['Mobile bookmarks'], addedAt: null },
  ]);
});

test('readBookmarks: reads local and account bookmarks together', async () => {
  const dir = profile();
  fs.writeFileSync(
    path.join(dir, 'Bookmarks'),
    JSON.stringify({
      roots: { bookmark_bar: folder('Bookmarks bar', [node('Local', 'https://l.example/'), node('Both', 'https://both.example/')]) },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'AccountBookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: folder('Bookmarks bar', [
          node('Both again', 'https://both.example/'),
          folder('Work', [node('Both', 'https://both.example/')]),
        ]),
        other: folder('Other bookmarks', [node('Account', 'https://acct.example/')]),
      },
    }),
  );
  assert.deepEqual(
    (await readBookmarks(dir)).map((b) => [b.title, b.url, b.folderPath.join('/')]),
    [
      ['Local', 'https://l.example/', 'Bookmarks bar'],
      ['Both', 'https://both.example/', 'Bookmarks bar'],
      ['Both again', 'https://both.example/', 'Bookmarks bar'],
      ['Both', 'https://both.example/', 'Bookmarks bar/Work'],
      ['Account', 'https://acct.example/', 'Other bookmarks'],
    ],
  );
});

test('readBookmarks: an unreadable account file still fails the read', async () => {
  const dir = profile();
  fs.writeFileSync(path.join(dir, 'Bookmarks'), '{"roots":{}}');
  fs.writeFileSync(path.join(dir, 'AccountBookmarks'), '{not json');
  await assert.rejects(readBookmarks(dir), (e: any) => e.code === 'read_failed');
  fs.rmSync(path.join(dir, 'AccountBookmarks'));
  fs.symlinkSync(path.join(dir, 'Bookmarks'), path.join(dir, 'AccountBookmarks'));
  await assert.rejects(readBookmarks(dir), (e: any) => e.code === 'read_failed');
});

// ---- history ----

function makeHistory(dir: string, hidden: boolean) {
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec(
    `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
       typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL${hidden ? ', hidden INTEGER DEFAULT 0 NOT NULL' : ''})`,
  );
  const rows: [string, string | null, number, number, bigint, number][] = [
    ['https://old.example/', 'Old', 1, 0, cr(NOW - 3 * DAY), 0],
    ['https://new.example/', 'New', 5, 2, cr(NOW - DAY), 0],
    ['http://mid.example/', null, 2, 1, cr(NOW - 2 * DAY), 0],
    ['https://hidden.example/', 'Hidden', 1, 0, cr(NOW), 1],
    ['chrome://settings/', 'Settings', 1, 0, cr(NOW), 0],
    ['file:///tmp/a.html', 'File', 1, 0, cr(NOW), 0],
    ['https://never.example/', 'Never', 1, 0, 0n, 0],
  ];
  const insert = db.prepare(
    hidden
      ? 'INSERT INTO urls (url,title,visit_count,typed_count,last_visit_time,hidden) VALUES (?,?,?,?,?,?)'
      : 'INSERT INTO urls (url,title,visit_count,typed_count,last_visit_time) VALUES (?,?,?,?,?)',
  );
  for (const [url, title, vc, tc, t, h] of rows) hidden ? insert.run(url, title, vc, tc, t, h) : insert.run(url, title, vc, tc, t);
  db.close();
}

test('readHistory: http(s) only, hidden rows skipped, most recent first, times converted', async () => {
  const dir = profile();
  makeHistory(dir, true);
  const out = await readHistory(dir);
  assert.deepEqual(out, [
    { url: 'https://new.example/', title: 'New', visitCount: 5, typedCount: 2, lastVisit: NOW - DAY },
    { url: 'http://mid.example/', title: '', visitCount: 2, typedCount: 1, lastVisit: NOW - 2 * DAY },
    { url: 'https://old.example/', title: 'Old', visitCount: 1, typedCount: 0, lastVisit: NOW - 3 * DAY },
    { url: 'https://never.example/', title: 'Never', visitCount: 1, typedCount: 0, lastVisit: 0 },
  ]);
});

test('readHistory: the limit is applied in SQL, and a schema without the hidden column still reads', async () => {
  const dir = profile();
  makeHistory(dir, false);
  assert.deepEqual(
    (await readHistory(dir, { limit: 2 })).map((v: any) => v.url),
    ['https://hidden.example/', 'https://new.example/'],
  );
  assert.equal((await readHistory(dir, { limit: 2.9 })).length, 2);
  assert.equal((await readHistory(dir, { limit: -5 })).length, 0);
  // the hidden row is only filtered when the column exists
  assert.ok((await readHistory(dir)).some((v: any) => v.url === 'https://hidden.example/'));
});

test('readHistory: a missing database is missing, a damaged one a failed read', async () => {
  const dir = profile();
  await assert.rejects(readHistory(dir), (e: any) => e.code === 'missing');
  fs.writeFileSync(path.join(dir, 'History'), 'not a database at all, just some text '.repeat(50));
  await assert.rejects(readHistory(dir), (e: any) => e.code === 'read_failed');
});

// ---- cookies ----

type Row = {
  host?: string;
  name?: string;
  value?: string;
  enc?: Buffer | null;
  path?: string;
  expires?: bigint;
  secure?: number;
  httpOnly?: number;
  sameSite?: number;
  persistent?: number;
  top?: string;
};

/** Writes a Cookies database at `file`: `version` null leaves out the meta table, `partition` false leaves out top_frame_site_key. */
function makeCookies(file: string, rows: Row[], { version = 24 as number | null, partition = true, metaRow = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB, path TEXT NOT NULL,
       expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL,
       is_persistent INTEGER NOT NULL${partition ? ", top_frame_site_key TEXT NOT NULL DEFAULT ''" : ''})`,
  );
  if (version !== null) {
    db.exec('CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)');
    if (metaRow) db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  }
  const cols = `host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,is_persistent${partition ? ',top_frame_site_key' : ''}`;
  const insert = db.prepare(`INSERT INTO cookies (${cols}) VALUES (${partition ? '?,?,?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?,?,?'})`);
  for (const r of rows) {
    const args: any[] = [
      r.host ?? '.example.com',
      r.name ?? 'sid',
      r.value ?? '',
      r.enc === undefined ? null : r.enc,
      r.path ?? '/',
      r.expires ?? cr(NOW + 30 * DAY),
      r.secure ?? 0,
      r.httpOnly ?? 0,
      r.sameSite ?? -1,
      r.persistent ?? 1,
    ];
    if (partition) args.push(r.top ?? '');
    insert.run(...args);
  }
  db.close();
}

const netCookies = (dir: string) => path.join(dir, 'Network', 'Cookies');

test('readCookies: decrypts v10 values under schema 23 and 24 and converts every field', async () => {
  for (const version of [23, 24]) {
    const dir = profile();
    makeCookies(
      netCookies(dir),
      [
        {
          host: '.example.com',
          name: 'a',
          enc: encryptValue('secret-a', key, '.example.com', version),
          secure: 1,
          httpOnly: 1,
          sameSite: 2,
          path: '/app',
        },
        { host: 'www.example.com', name: 'b', enc: encryptValue('secret-b', key, 'www.example.com', version), sameSite: 1 },
        { name: 'c', value: 'plain-c', enc: null, sameSite: 0 },
        { name: 'd', value: 'plain-d', enc: Buffer.alloc(0), sameSite: 7 },
        { name: 'e', enc: encryptValue('', key, '.example.com', version) },
      ],
      { version },
    );
    const { cookies, stats } = await readCookies(dir, key, { now: NOW });
    const expires = Math.floor((NOW + 30 * DAY) / 1000);
    assert.deepEqual(cookies, [
      {
        host: '.example.com',
        name: 'a',
        value: 'secret-a',
        path: '/app',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expires,
        hostOnly: false,
      },
      {
        host: 'www.example.com',
        name: 'b',
        value: 'secret-b',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
        expires,
        hostOnly: true,
      },
      {
        host: '.example.com',
        name: 'c',
        value: 'plain-c',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'no_restriction',
        expires,
        hostOnly: false,
      },
      {
        host: '.example.com',
        name: 'd',
        value: 'plain-d',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'unspecified',
        expires,
        hostOnly: false,
      },
      {
        host: '.example.com',
        name: 'e',
        value: '',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'unspecified',
        expires,
        hostOnly: false,
      },
    ]);
    assert.deepEqual(stats, { total: 5, imported: 5, expired: 0, session: 0, partitioned: 0, unsupported: 0, undecryptable: 0 });
  }
});

test('readCookies: partitioned, session, expired, unsupported and undecryptable rows are counted and skipped', async () => {
  const dir = profile();
  const ok = (host = '.example.com') => encryptValue('v', key, host, 24);
  makeCookies(netCookies(dir), [
    { name: 'good', enc: ok() },
    { name: 'part', enc: ok(), top: 'https://top.example' },
    { name: 'sess1', enc: ok(), persistent: 0 },
    { name: 'sess2', enc: ok(), expires: 0n },
    { name: 'exp1', enc: ok(), expires: cr(NOW - DAY) },
    { name: 'exp2', enc: ok(), expires: cr(NOW) },
    { name: 'v11', enc: Buffer.concat([Buffer.from('v11'), Buffer.alloc(32, 1)]) },
    { name: 'v20', enc: Buffer.concat([Buffer.from('v20'), Buffer.alloc(32, 1)]) },
    { name: 'wrong', enc: encryptValue('v', wrongKey, '.example.com', 24) },
    { name: 'otherhost', enc: encryptValue('v', key, '.other.com', 24) },
    { name: 'junk', enc: Buffer.from('v10-not-really-encrypted-data-at-all') },
    { name: 'short', enc: Buffer.from('v10') },
    // precedence: a partitioned session cookie counts as partitioned; an expired v11 as expired
    { name: 'p-sess', enc: ok(), top: 'https://t', persistent: 0 },
    { name: 'exp-v11', enc: Buffer.from('v11xxxxxxxxxxxxxxxxxxxx'), expires: cr(NOW - DAY) },
  ]);
  const { cookies, stats } = await readCookies(dir, key, { now: NOW });
  assert.deepEqual(
    cookies.map((c: any) => c.name),
    ['good'],
  );
  assert.deepEqual(stats, { total: 14, imported: 1, expired: 3, session: 2, partitioned: 2, unsupported: 2, undecryptable: 4 });
});

test('readCookies: without a key encrypted rows are undecryptable, plaintext rows still import, v11 stays unsupported', async () => {
  const dir = profile();
  makeCookies(netCookies(dir), [
    { name: 'enc', enc: encryptValue('v', key, '.example.com', 24) },
    { name: 'plain', value: 'p', enc: null },
    { name: 'v11', enc: Buffer.from('v11xxxxxxxxxxxxxxxxxxxx') },
  ]);
  for (const k of [null, undefined]) {
    const { cookies, stats } = await readCookies(dir, k, { now: NOW });
    assert.deepEqual(
      cookies.map((c: any) => c.value),
      ['p'],
    );
    assert.deepEqual(stats, { total: 3, imported: 1, expired: 0, session: 0, partitioned: 0, unsupported: 1, undecryptable: 1 });
  }
});

test('readCookies: expiry is clamped to 400 days, not skipped, and large 2020s values stay exact', async () => {
  const dir = profile();
  makeCookies(netCookies(dir), [
    { name: 'far', value: 'x', enc: null, expires: cr(NOW + 10 * 365 * DAY) },
    { name: 'forever', value: 'x', enc: null, expires: 9_000_000_000_000_000_000n },
    { name: 'near', value: 'x', enc: null, expires: cr(NOW + 1500) },
  ]);
  const { cookies, stats } = await readCookies(dir, key, { now: NOW });
  const max = Math.floor(NOW / 1000) + 400 * 86400;
  assert.deepEqual(
    cookies.map((c: any) => [c.name, c.expires]),
    [
      ['far', max],
      ['forever', max],
      ['near', Math.floor(NOW / 1000) + 1],
    ],
  );
  assert.equal(stats.imported, 3);
});

test('readCookies: the schema version defaults to 0 without a meta table or version row', async () => {
  for (const opts of [{ version: null }, { version: 24, metaRow: false }]) {
    const dir = profile();
    // written the pre-24 way (no host hash), which only opens when the reader assumes version < 24
    makeCookies(netCookies(dir), [{ name: 'old', enc: encryptValue('legacy', key, '.example.com', 23) }], opts);
    const { cookies } = await readCookies(dir, key, { now: NOW });
    assert.deepEqual(
      cookies.map((c: any) => c.value),
      ['legacy'],
    );
  }
});

test('readCookies: an old schema without top_frame_site_key reads, and the default clock is used', async () => {
  const dir = profile();
  makeCookies(netCookies(dir), [{ name: 'a', value: 'x', enc: null, expires: cr(Date.now() + 10 * DAY) }], { partition: false });
  const { cookies, stats } = await readCookies(dir, key);
  assert.equal(cookies.length, 1);
  assert.equal(stats.partitioned, 0);
});

test('readCookies: falls back to Cookies in the profile root, and reports missing when neither exists', async () => {
  const dir = profile();
  await assert.rejects(readCookies(dir, key, { now: NOW }), (e: any) => e.code === 'missing');
  makeCookies(path.join(dir, 'Cookies'), [{ name: 'legacy', value: 'x', enc: null }]);
  const { cookies } = await readCookies(dir, key, { now: NOW });
  assert.deepEqual(
    cookies.map((c: any) => c.name),
    ['legacy'],
  );
});

test('readCookies: a damaged Network/Cookies is a failed read and does not fall back to an older file', async () => {
  const dir = profile();
  makeCookies(path.join(dir, 'Cookies'), [{ name: 'legacy', value: 'x', enc: null }]);
  fs.mkdirSync(path.join(dir, 'Network'));
  fs.writeFileSync(netCookies(dir), 'garbage that is not a sqlite database '.repeat(50));
  await assert.rejects(readCookies(dir, key, { now: NOW }), (e: any) => e.code === 'read_failed');
});

test('readCookies: no error or stat leaks a cookie value or the key', async () => {
  const dir = profile();
  fs.mkdirSync(path.join(dir, 'Network'));
  fs.writeFileSync(netCookies(dir), 'SECRETVALUE'.repeat(100));
  await assert.rejects(
    readCookies(dir, key, { now: NOW }),
    (e: any) => !String(e.message).includes('SECRETVALUE') && !String(e.message).includes(key.toString('hex')),
  );
});
