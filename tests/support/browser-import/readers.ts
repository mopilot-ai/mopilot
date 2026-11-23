// Browser import readers cases using shared fake sessions, storage, and readers.
import {
  test,
  assert,
  DatabaseSync,
  fs,
  path,
  createImporter,
  createBrowserData,
  deriveKey,
  encryptValue,
  tmp,
  fakeSession,
} from './fixture.ts';

export function registerReaders() {
  test("createImporter: lists the sources of a home and reads a Chrome profile's bookmarks, history and cookies", async () => {
    const home = tmp();
    const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const profile = path.join(root, 'Default');
    fs.mkdirSync(path.join(profile, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }));
    fs.writeFileSync(
      path.join(profile, 'Bookmarks'),
      JSON.stringify({
        roots: {
          bookmark_bar: {
            type: 'folder',
            name: 'Bar',
            children: [{ type: 'url', name: 'Docs', url: 'https://docs.test/', date_added: '13400000000000000' }],
          },
        },
      }),
    );
    const hist = new DatabaseSync(path.join(profile, 'History'));
    hist.exec(
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)',
    );
    hist
      .prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, 1, 0, 13400000000000000, 0)')
      .run('https://seen.test/', 'Seen');
    hist.close();
    const key = deriveKey('pw');
    const db = new DatabaseSync(path.join(profile, 'Network', 'Cookies'));
    db.exec(
      'CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER, top_frame_site_key TEXT)',
    );
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', '24');
    const farFuture = String((Date.now() / 1000 + 86400 * 30 + 11644473600) * 1e6);
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?)').run(
      '.example.com',
      'sid',
      '',
      encryptValue('abc', key, '.example.com', 24),
      '/',
      farFuture,
      '',
    );
    db.close();
    const data = createBrowserData({ userData: () => tmp() });
    const asked: string[][] = [];
    const execFile = (cmd: string, args: string[], _o: any, cb: (e: Error | null, out?: string) => void) => {
      asked.push([cmd, ...args]);
      cb(new Error('The specified item could not be found in the keychain.'));
    };
    const importer = createImporter({
      userData: () => tmp(),
      data,
      session: () => fakeSession(),
      broadcast: () => {},
      home,
      platform: 'darwin',
      execFile,
    });
    const chrome = importer.sources().find((s: any) => s.id === 'chrome');
    assert.equal(chrome.status, 'ready');
    assert.equal(chrome.profiles[0].name, 'Work');
    const readers = importer.o.readers.chromium;
    assert.equal((await readers.bookmarks(chrome.profiles[0]))[0].title, 'Docs');
    assert.equal((await readers.history(chrome.profiles[0]))[0].url, 'https://seen.test/');
    const read = await readers.cookies(chrome.profiles[0], key);
    assert.equal(read.cookies[0].value, 'abc');
    // the key reader asks the keychain for the browser's item (here a fake that has none)
    await assert.rejects(() => importer.o.key('Chrome Safe Storage'), { code: 'keychain_denied' });
    assert.deepEqual(asked[0].slice(0, 2), ['security', 'find-generic-password']);
    // Safari's readers read the same home (nothing there)
    const safariReaders = importer.o.readers.safari;
    for (const name of ['bookmarks', 'history', 'cookies']) await assert.rejects(() => safariReaders[name]({}), { code: 'missing' });
    // Safari's passwords: the exported file the user chose, or none yet
    await assert.rejects(() => safariReaders.passwords({}, null, { file: null }), { code: 'no_file' });
    const csv = path.join(tmp(), 'Passwords.csv');
    fs.writeFileSync(csv, 'Title,URL,Username,Password,Notes,OTPAuth\nEx,https://ex.test/login,me,pw,,\n');
    assert.deepEqual((await safariReaders.passwords({}, null, { file: csv })).logins, [
      { origin: 'https://ex.test', username: 'me', password: 'pw' },
    ]);
    // the passwords reader reads the profile's Login Data (none here)
    await assert.rejects(() => readers.passwords(chrome.profiles[0], key), { code: 'missing' });
  });
}
