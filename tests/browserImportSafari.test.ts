// Safari import readers: History.db, Bookmarks.plist (through plutil, faked and real) and the binarycookies parser, with real SQLite files and byte-built cookie fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseBinaryCookies } = require('../electron/capabilities/browser/import/binaryCookies.cjs');
const { safariPaths, readHistory, readBookmarks, readCookies } = require('../electron/capabilities/browser/import/safari.cjs');

const MAC = 978307200;
const NOW = Date.UTC(2026, 0, 1);
const nowMac = NOW / 1000 - MAC;
const DAY = 86400;

// ---- binarycookies builder ----
type Spec = {
  host?: string;
  name?: string;
  path?: string;
  value?: string;
  flags?: number;
  expires?: number;
  created?: number; // Mac absolute seconds
  mutate?: (rec: Buffer) => void;
};

function cstr(s: string) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function record(s: Spec) {
  const strs = [s.host ?? 'example.com', s.name ?? 'n', s.path ?? '/', s.value ?? 'v'].map(cstr);
  const head = 56;
  const offs: number[] = [];
  let at = head;
  for (const b of strs) {
    offs.push(at);
    at += b.length;
  }
  const rec = Buffer.alloc(at);
  rec.writeUInt32LE(at, 0);
  rec.writeUInt32LE(0, 4);
  rec.writeUInt32LE(s.flags ?? 0, 8);
  offs.forEach((o, i) => rec.writeUInt32LE(o, 16 + i * 4));
  rec.writeUInt32LE(0xdeadbeef, 32); // end marker bytes are not interpreted
  rec.writeDoubleLE(s.expires ?? nowMac + 30 * DAY, 40);
  rec.writeDoubleLE(s.created ?? nowMac - DAY, 48);
  strs.forEach((b, i) => b.copy(rec, offs[i]));
  s.mutate?.(rec);
  return rec;
}

function page(recs: Buffer[], opts: { count?: number; header?: number; offsets?: number[] } = {}) {
  const count = opts.count ?? recs.length;
  const tableEnd = 8 + recs.length * 4;
  const offsets: number[] = [];
  let at = tableEnd;
  for (const r of recs) {
    offsets.push(at);
    at += r.length;
  }
  const buf = Buffer.alloc(at);
  // the page tag is big-endian on disk (00 00 01 00); the fields after it are little-endian
  buf.writeUInt32BE(opts.header ?? 0x100, 0);
  buf.writeUInt32LE(count, 4);
  (opts.offsets ?? offsets).forEach((o, i) => buf.writeUInt32LE(o, 8 + i * 4));
  let w = tableEnd;
  for (const r of recs) {
    r.copy(buf, w);
    w += r.length;
  }
  return buf;
}

function file(pages: Buffer[], opts: { magic?: string; sizes?: number[] } = {}) {
  const head = Buffer.alloc(8 + pages.length * 4);
  head.write(opts.magic ?? 'cook', 0, 'latin1');
  head.writeUInt32BE(pages.length, 4);
  (opts.sizes ?? pages.map((p) => p.length)).forEach((n, i) => head.writeUInt32BE(n, 8 + i * 4));
  return Buffer.concat([head, ...pages, Buffer.alloc(8)]); // trailing checksum bytes
}

const parse = (b: Buffer) => parseBinaryCookies(b, { now: NOW });
const damaged = (fn: () => unknown) => assert.throws(fn, (e: any) => e.name === 'ImportError' && e.code === 'read_failed');

test('binarycookies: pages, flags, hostOnly, converted dates and stats', () => {
  const exp = nowMac + 10 * DAY;
  const buf = file([
    page([
      record({ host: '.shop.example', name: 'a', value: 'one', flags: 1 | 4, expires: exp }),
      record({ host: 'www.example.com', name: 'b', path: '/x', value: 'two', flags: 4, expires: exp }),
    ]),
    page([record({ host: 'plain.test', name: 'c', value: '', flags: 2 | 1, expires: exp })]),
  ]);
  const { cookies, stats } = parse(buf);
  assert.deepEqual(stats, { total: 3, imported: 3, expired: 0 });
  assert.deepEqual(cookies[0], {
    host: '.shop.example',
    name: 'a',
    value: 'one',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'unspecified',
    expires: exp + MAC,
    hostOnly: false,
  });
  assert.equal(cookies[1].secure, false);
  assert.equal(cookies[1].httpOnly, true);
  assert.equal(cookies[1].hostOnly, true);
  assert.equal(cookies[1].path, '/x');
  assert.equal(cookies[2].secure, true);
  assert.equal(cookies[2].httpOnly, false);
  assert.equal(cookies[2].value, '');
});

test('binarycookies: session, expired and far-future cookies', () => {
  const { cookies, stats } = parse(
    file([
      page([
        record({ name: 'session', expires: nowMac - 5, created: nowMac - 5 }), // expiry == creation
        record({ name: 'zero', expires: 0, created: -10 }),
        record({ name: 'old', expires: nowMac - DAY, created: nowMac - 3 * DAY }),
        record({ name: 'edge', expires: nowMac, created: nowMac - DAY }), // not after now
        record({ name: 'long', expires: nowMac + 3000 * DAY }),
        record({ name: 'ok', expires: nowMac + 5 * DAY }),
      ]),
    ]),
  );
  assert.deepEqual(stats, { total: 6, imported: 2, expired: 2 });
  assert.deepEqual(
    cookies.map((c: any) => c.name),
    ['long', 'ok'],
  );
  assert.equal(cookies[0].expires, NOW / 1000 + 400 * DAY);
  assert.equal(cookies[1].expires, nowMac + 5 * DAY + MAC);
});

test('binarycookies: uses the current time when none is given', () => {
  const soon = Date.now() / 1000 - MAC + 3600;
  const { stats } = parseBinaryCookies(file([page([record({ expires: soon, created: soon - 10 })])]));
  assert.equal(stats.imported, 1);
});

test('binarycookies: a file without pages is valid and empty', () => {
  assert.deepEqual(parse(file([])), { cookies: [], stats: { total: 0, imported: 0, expired: 0 } });
});

test('binarycookies: malformed records are skipped, the rest still import', () => {
  const good = record({ name: 'good' });
  const u32 = (n: number) => (rec: Buffer) => rec.writeUInt32LE(n, 16);
  const bad = [
    record({ mutate: u32(0) }), // host offset inside the header
    record({ mutate: u32(9999) }), // host offset past the record
    record({ mutate: (r) => r.writeUInt32LE(r.length, 20) }), // name offset at the record end
    record({
      mutate: (r) => {
        r[r.length - 1] = 0x41;
      },
    }), // value loses its terminator
    record({ mutate: (r) => r.writeDoubleLE(Number.NaN, 40) }),
    record({ mutate: (r) => r.writeDoubleLE(Number.POSITIVE_INFINITY, 48) }),
  ];
  const { cookies, stats } = parse(file([page([...bad, good])]));
  assert.deepEqual(
    cookies.map((c: any) => c.name),
    ['good'],
  );
  assert.deepEqual(stats, { total: 7, imported: 1, expired: 0 });
});

test('binarycookies: bad record bounds are skipped', () => {
  const rec = record({ name: 'good' });
  const tableEnd = 8 + 5 * 4;
  const p = page([rec, rec, rec, rec, rec], {
    offsets: [
      0, // inside the table
      tableEnd + rec.length * 5 + 100, // past the page
      tableEnd, // the one valid cookie
      tableEnd + rec.length - 2, // record header cut by page end? still in page but size garbage
      tableEnd + 1, // misaligned: size field reads garbage
    ],
  });
  const { cookies, stats } = parse(file([p]));
  assert.equal(stats.total, 5);
  assert.equal(cookies.filter((c: any) => c.name === 'good').length, 1);
});

test('binarycookies: record size too small or beyond the page is skipped', () => {
  const small = record({ name: 'small' });
  small.writeUInt32LE(10, 0);
  const big = record({ name: 'big' });
  big.writeUInt32LE(1 << 20, 0);
  const { cookies, stats } = parse(file([page([small, big, record({ name: 'ok' })])]));
  assert.deepEqual(
    cookies.map((c: any) => c.name),
    ['ok'],
  );
  assert.equal(stats.total, 3);
});

test('binarycookies: damaged files throw read_failed', () => {
  const ok = file([page([record({})])]);
  damaged(() => parse('nope' as unknown as Buffer));
  damaged(() => parse(Buffer.alloc(0)));
  damaged(() => parse(Buffer.from('cook')));
  damaged(() => parse(file([page([record({})])], { magic: 'koop' })));
  // truncated: page table promises more than the file holds
  damaged(() => parse(ok.subarray(0, 10)));
  // truncated in the middle of a page
  damaged(() => parse(ok.subarray(0, 40)));
  // absurd page count
  const many = Buffer.from(ok);
  many.writeUInt32BE(0xffffffff, 4);
  damaged(() => parse(many));
  // page count larger than the table that is present
  const table = Buffer.from(ok);
  table.writeUInt32BE(5000, 4);
  damaged(() => parse(table.subarray(0, 100)));
  // page sizes outside the file / too small
  damaged(() => parse(file([page([record({})])], { sizes: [0x7fffffff] })));
  damaged(() => parse(file([page([record({})])], { sizes: [4] })));
  // bad page header, including the tag written little-endian (00 01 00 00 read big-endian)
  damaged(() => parse(file([page([record({})], { header: 0x200 })])));
  damaged(() => parse(file([page([record({})], { header: 0x10000 })])));
  // absurd cookie counts
  damaged(() => parse(file([page([record({})], { count: 0xffffffff })])));
  damaged(() => parse(file([page([record({})], { count: 100000 })])));
  damaged(() => parse(file([page([record({})], { count: 1000 })])));
});

// ---- safari.cjs ----
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'safari-import-'));
const safariDir = (home: string) => {
  const d = path.join(home, 'Library', 'Safari');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const fakeStat = (over: object) => ({ isSymbolicLink: () => false, size: 1, ...over });
const failFs = (method: string, code: string, only?: string) =>
  Object.assign({}, fs, {
    [method]: (p: string, ...rest: unknown[]) => {
      if (only && !String(p).endsWith(only)) return (fs as any)[method](p, ...rest);
      throw Object.assign(new Error(code), { code });
    },
  });
const code = (c: string) => (e: any) => e.name === 'ImportError' && e.code === c;

test('safariPaths: history, bookmarks and the two cookie candidates in order', () => {
  const p = safariPaths('/h');
  assert.equal(p.history, '/h/Library/Safari/History.db');
  assert.equal(p.bookmarks, '/h/Library/Safari/Bookmarks.plist');
  assert.deepEqual(p.cookies, [
    '/h/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
    '/h/Library/Cookies/Cookies.binarycookies',
  ]);
  assert.equal(safariPaths().history, path.join(os.homedir(), 'Library', 'Safari', 'History.db'));
});

function makeHistory(home: string) {
  const db = new DatabaseSync(path.join(safariDir(home), 'History.db'));
  db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
    CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);`);
  const item = db.prepare('INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)');
  const visit = db.prepare('INSERT INTO history_visits (id, history_item, visit_time, title) VALUES (?, ?, ?, ?)');
  item.run(1, 'https://a.example/', 5);
  visit.run(1, 1, 100, 'A old');
  visit.run(2, 1, 300.5, 'A new');
  visit.run(3, 1, 200, 'A mid');
  item.run(2, 'http://b.example/', null);
  visit.run(4, 2, 400, null); // newest, no title, no count
  item.run(3, 'ftp://c.example/', 1);
  visit.run(5, 3, 500, 'ftp');
  item.run(4, 'https://d.example/', 2); // never visited: left out
  item.run(5, 'https://e.example/', 1);
  visit.run(6, 5, 50, 'E');
  item.run(6, 'https://f.example/', 1);
  visit.run(7, 6, 50, 'F tie, higher id');
  visit.run(8, 6, 50, 'F tie, newer row');
  db.close();
}

test('readHistory: latest visit per page, web URLs only, newest first, Unix milliseconds', async () => {
  const home = tmpHome();
  makeHistory(home);
  const rows = await readHistory({ home });
  assert.deepEqual(rows, [
    { url: 'http://b.example/', title: '', visitCount: 0, typedCount: 0, lastVisit: Math.round((400 + MAC) * 1000) },
    { url: 'https://a.example/', title: 'A new', visitCount: 5, typedCount: 0, lastVisit: Math.round((300.5 + MAC) * 1000) },
    { url: 'https://f.example/', title: 'F tie, newer row', visitCount: 1, typedCount: 0, lastVisit: (50 + MAC) * 1000 },
    { url: 'https://e.example/', title: 'E', visitCount: 1, typedCount: 0, lastVisit: (50 + MAC) * 1000 },
  ]);
  assert.deepEqual(
    (await readHistory({ home, limit: 2 })).map((r: any) => r.url),
    ['http://b.example/', 'https://a.example/'],
  );
  assert.equal((await readHistory({ home, limit: 0 })).length, 1);
  assert.equal((await readHistory({ home, limit: 'x' as unknown as number })).length, 1);
  assert.equal((await readHistory({ home, limit: 2.9 })).length, 2);
  assert.deepEqual(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mopilot-import-') && fs.existsSync(path.join(os.tmpdir(), n, 'db'))),
    [],
  );
});

test('readHistory: errors are classified', async () => {
  const home = tmpHome();
  await assert.rejects(readHistory({ home }), code('missing'));
  safariDir(home);
  fs.writeFileSync(path.join(home, 'Library', 'Safari', 'History.db'), 'not a database');
  await assert.rejects(readHistory({ home }), code('read_failed'));
  await assert.rejects(readHistory({ home, fs: failFs('lstatSync', 'EPERM') }), code('access_blocked'));
});

const leaf = (title: string | undefined, url: unknown, extra: object = {}) => ({
  WebBookmarkType: 'WebBookmarkTypeLeaf',
  URLString: url,
  ...(title === undefined ? {} : { URIDictionary: { title } }),
  ...extra,
});
const list = (Title: string | undefined, Children: unknown) => ({
  WebBookmarkType: 'WebBookmarkTypeList',
  ...(Title === undefined ? {} : { Title }),
  Children,
});

function homeWithPlist() {
  const home = tmpHome();
  fs.writeFileSync(path.join(safariDir(home), 'Bookmarks.plist'), 'bplist00');
  return home;
}
/** A JS value as the XML property list `plutil -convert xml1` prints. */
const xmlEscape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v: unknown): string {
  if (v === null || v === undefined) return '<string></string>';
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return `<integer>${v}</integer>`;
  if (typeof v === 'string') return `<string>${xmlEscape(v)}</string>`;
  if (Array.isArray(v)) return `<array>${v.map(plistValue).join('')}</array>`;
  return `<dict>${Object.entries(v as object)
    .map(([k, x]) => `<key>${xmlEscape(k)}</key>${plistValue(x)}`)
    .join('')}</dict>`;
}
const toPlist = (v: unknown) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(v)}\n</plist>\n`;
/** A fake plutil printing `tree` as an XML plist (a string is printed as is). */
const plutil =
  (tree: unknown, calls: any[] = []) =>
  (cmd: string, args: string[], opts: any, cb: Function) => {
    calls.push({ cmd, args, opts });
    cb(null, typeof tree === 'string' ? tree : toPlist(tree), '');
  };

test('readBookmarks: folders, special titles, nesting, reading list, proxies and non-web leaves', async () => {
  const home = homeWithPlist();
  const calls: any[] = [];
  const tree = {
    Title: '',
    Children: [
      { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History', Children: [leaf('no', 'https://history.example/')] },
      list('BookmarksBar', [
        leaf('Site', 'https://site.example/'),
        list('Work', [list('Deep', [leaf(undefined, 'http://deep.example/')]), leaf('', 'https://untitled.example/')]),
        leaf('Script', 'javascript:alert(1)'),
        leaf('File', 'file:///etc/hosts'),
        leaf('Nourl', undefined),
        null,
        'junk',
      ]),
      list('BookmarksMenu', [leaf('Menu', 'https://menu.example/')]),
      list('com.apple.ReadingList', [leaf('Read me', 'https://read.example/', { ReadingList: { DateAdded: 'x' } })]),
      list(undefined, [leaf('Loose', 'https://loose.example/')]),
      list('constructor', [leaf('Weird', 'https://weird.example/')]),
      { WebBookmarkType: 'WebBookmarkTypeList', Title: 'No children' },
      { WebBookmarkType: 'Other' },
    ],
  };
  const out = await readBookmarks({ home, execFile: plutil(tree, calls) });
  assert.deepEqual(out, [
    { title: 'Site', url: 'https://site.example/', folderPath: ['Favorites'], addedAt: null },
    { title: 'http://deep.example/', url: 'http://deep.example/', folderPath: ['Favorites', 'Work', 'Deep'], addedAt: null },
    { title: 'https://untitled.example/', url: 'https://untitled.example/', folderPath: ['Favorites', 'Work'], addedAt: null },
    { title: 'Menu', url: 'https://menu.example/', folderPath: ['Bookmarks Menu'], addedAt: null },
    { title: 'Read me', url: 'https://read.example/', folderPath: ['Reading List'], addedAt: null },
    { title: 'Loose', url: 'https://loose.example/', folderPath: [], addedAt: null },
    { title: 'Weird', url: 'https://weird.example/', folderPath: ['constructor'], addedAt: null },
  ]);
  assert.equal(calls[0].cmd, '/usr/bin/plutil');
  assert.deepEqual(calls[0].args, ['-convert', 'xml1', '-o', '-', '--', path.join(home, 'Library', 'Safari', 'Bookmarks.plist')]);
  assert.equal(calls[0].opts.timeout, 30000);
  // room for the XML of a binary plist at the 64 MiB size limit
  assert.equal(calls[0].opts.maxBuffer, 4 * 64 * 1024 * 1024);
  assert.equal(fs.readFileSync(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'), 'utf8'), 'bplist00');
});

test('readBookmarks: a leaf without a title dictionary uses its URL; odd roots yield nothing', async () => {
  const home = homeWithPlist();
  const out = await readBookmarks({
    home,
    execFile: plutil({ Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://x.example/' }] }),
  });
  assert.equal(out[0].title, 'https://x.example/');
  assert.deepEqual(await readBookmarks({ home, execFile: plutil({}) }), []);
  assert.deepEqual(await readBookmarks({ home, execFile: plutil(toPlist('text')) }), []);
  assert.deepEqual(await readBookmarks({ home, execFile: plutil(toPlist(5)) }), []);
});

test('readBookmarks: folder nesting is bounded', async () => {
  const home = homeWithPlist();
  let node: any = list('x', [leaf('Bottom', 'https://bottom.example/')]);
  for (let i = 0; i < 100; i++) node = list(`f${i}`, [node, leaf(`L${i}`, `https://l${i}.example/`)]);
  const out = await readBookmarks({ home, execFile: plutil({ Children: [node] }) });
  assert.ok(out.length > 10 && out.length < 100);
  assert.ok(!out.some((b: any) => b.title === 'Bottom'));
});

test('readBookmarks: default execFile is child_process.execFile', async () => {
  const home = homeWithPlist();
  const real = childProcess.execFile;
  let seen = '';
  (childProcess as any).execFile = (cmd: string, _a: string[], _o: object, cb: Function) => {
    seen = cmd;
    cb(null, toPlist({ Children: [leaf('T', 'https://t.example/')] }), '');
  };
  try {
    assert.equal((await readBookmarks({ home })).length, 1);
  } finally {
    (childProcess as any).execFile = real;
  }
  assert.equal(seen, '/usr/bin/plutil');
});

// The fakes above print what the code expects; this runs the real plutil on a binary plist shaped like Safari's,
// with the data and date values a real Bookmarks.plist holds (plutil cannot print those as JSON).
test('readBookmarks: reads a binary Bookmarks.plist with data and date values through the real plutil', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = tmpHome();
  const file = path.join(safariDir(home), 'Bookmarks.plist');
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Sync</key><dict><key>Data</key><data>AAECAw==</data></dict>
  <key>Children</key><array>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Title</key><string>BookmarksBar</string>
      <key>Children</key><array>
        <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://a.example/?x=1&amp;y=2</string>
          <key>URIDictionary</key><dict><key>title</key><string>A &lt;&amp;&gt; \u00e9</string></dict></dict>
      </array></dict>
    <dict><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Title</key><string>com.apple.ReadingList</string>
      <key>Children</key><array>
        <dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://r.example/</string>
          <key>ReadingList</key><dict><key>DateAdded</key><date>2026-01-02T03:04:05Z</date><key>PreviewText</key><string>p</string></dict>
          <key>imageURL</key><data>iVBORw0KGgo=</data><key>Sort</key><real>1.5</real><key>Pinned</key><false/></dict>
      </array></dict>
  </array>
</dict></plist>`,
  );
  childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file]);
  assert.equal(fs.readFileSync(file).subarray(0, 8).toString('latin1'), 'bplist00');
  assert.deepEqual(await readBookmarks({ home }), [
    { title: 'A <&> \u00e9', url: 'https://a.example/?x=1&y=2', folderPath: ['Favorites'], addedAt: null },
    { title: 'https://r.example/', url: 'https://r.example/', folderPath: ['Reading List'], addedAt: null },
  ]);
});

test('readBookmarks: failures map to ImportError codes', async () => {
  const home = tmpHome();
  await assert.rejects(readBookmarks({ home, execFile: plutil({}) }), code('missing'));
  const withPlist = homeWithPlist();
  await assert.rejects(
    readBookmarks({
      home: withPlist,
      execFile: (_c: string, _a: string[], _o: object, cb: Function) => cb(new Error('plutil: bad plist')),
    }),
    code('read_failed'),
  );
  await assert.rejects(readBookmarks({ home: withPlist, execFile: plutil('<plist><dict><key>x</key>') }), code('read_failed'));
  await assert.rejects(
    readBookmarks({ home: withPlist, execFile: plutil({}), fs: failFs('openSync', 'EPERM', 'Bookmarks.plist') }),
    code('access_blocked'),
  );
  await assert.rejects(
    readBookmarks({ home: withPlist, execFile: plutil({}), fs: failFs('openSync', 'EACCES', 'Bookmarks.plist') }),
    code('access_blocked'),
  );
  const link = tmpHome();
  fs.symlinkSync(path.join(withPlist, 'Library', 'Safari', 'Bookmarks.plist'), path.join(safariDir(link), 'Bookmarks.plist'));
  await assert.rejects(readBookmarks({ home: link, execFile: plutil({}) }), code('read_failed'));
  const huge = Object.assign({}, fs, { lstatSync: () => fakeStat({ size: 64 * 1024 * 1024 + 1 }) });
  await assert.rejects(readBookmarks({ home: withPlist, execFile: plutil({}), fs: huge }), code('too_large'));
});

const cookieFile = (home: string, which: 0 | 1, bytes: Buffer) => {
  const target = safariPaths(home).cookies[which];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
};
const sample = (name: string) => file([page([record({ name })])]);

test('readCookies: first existing candidate wins, falls through only on ENOENT', async () => {
  const home = tmpHome();
  await assert.rejects(readCookies({ home, now: NOW }), code('missing'));
  cookieFile(home, 1, sample('legacy'));
  assert.equal((await readCookies({ home, now: NOW })).cookies[0].name, 'legacy');
  cookieFile(home, 0, sample('container'));
  const res = await readCookies({ home, now: NOW });
  assert.equal(res.cookies[0].name, 'container');
  assert.deepEqual(res.stats, { total: 1, imported: 1, expired: 0 });
  assert.equal((await readCookies({ home })).stats.total, 1);
});

test('readCookies: a blocked first candidate is not skipped', async () => {
  const home = tmpHome();
  cookieFile(home, 0, sample('container'));
  cookieFile(home, 1, sample('legacy'));
  const first = safariPaths(home).cookies[0];
  await assert.rejects(readCookies({ home, now: NOW, fs: failFs('lstatSync', 'EPERM', first) }), code('access_blocked'));
  await assert.rejects(readCookies({ home, now: NOW, fs: failFs('readFileSync', 'EACCES', first) }), code('access_blocked'));
});

test('readCookies: symlinks, huge files and damaged files are refused', async () => {
  const home = tmpHome();
  const real = path.join(tmpHome(), 'real.binarycookies');
  fs.writeFileSync(real, sample('x'));
  const target = safariPaths(home).cookies[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(real, target);
  await assert.rejects(readCookies({ home, now: NOW }), code('read_failed'));
  const huge = Object.assign({}, fs, { lstatSync: () => fakeStat({ size: 64 * 1024 * 1024 + 1 }) });
  await assert.rejects(readCookies({ home, now: NOW, fs: huge }), code('too_large'));
  const bad = tmpHome();
  cookieFile(bad, 0, Buffer.from('garbage!garbage!'));
  await assert.rejects(readCookies({ home: bad, now: NOW }), code('read_failed'));
});
