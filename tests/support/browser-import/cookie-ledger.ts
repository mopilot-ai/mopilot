// Browser import cookie ledger cases using shared fake sessions, storage, and readers.
import {
  test,
  assert,
  fs,
  path,
  siteOf,
  sensitiveReason,
  groupCookies,
  cookieUrl,
  setDetails,
  writeCookies,
  ImportLedger,
  tmp,
  T0,
  cookie,
  fakeSession,
} from './fixture.ts';

export function registerCookieLedger() {
  test('siteOf: the registrable domain of a cookie host', () => {
    assert.equal(siteOf('.docs.example.com'), 'example.com');
    assert.equal(siteOf('www.example.co.uk'), 'example.co.uk');
    assert.equal(siteOf('example.co.uk'), 'example.co.uk');
    assert.equal(siteOf('foo.com.au'), 'foo.com.au');
    assert.equal(siteOf('co.uk'), 'co.uk', 'a bare suffix has no label to keep');
    assert.equal(siteOf('Example.COM.'), 'example.com');
    assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
    assert.equal(siteOf('localhost'), 'localhost');
    assert.equal(siteOf('::1'), '::1');
    assert.equal(siteOf(''), '');
    assert.equal(siteOf(undefined), '');
  });

  test('sensitiveReason and groupCookies: risk classes and sign-in providers are not pre-selected; busiest site first', () => {
    assert.match(sensitiveReason('chase.com'), /bank/i);
    assert.equal(sensitiveReason('google.com'), 'Email or sign-in provider');
    assert.equal(sensitiveReason('example.com'), null);
    const groups = groupCookies([
      { host: '.example.com' },
      { host: 'www.example.com' },
      { host: '.chase.com' },
      { host: '.google.com' },
      { host: '.google.com' },
      { host: '.google.com' },
      { host: '' },
    ]);
    assert.deepEqual(
      groups.map((g: any) => [g.site, g.count, g.sensitive]),
      [
        ['google.com', 3, true],
        ['example.com', 2, false],
        ['chase.com', 1, true],
      ],
    );
    assert.equal(groups[1].reason, null);
  });

  test('cookieUrl and setDetails: what Electron needs to set or remove a cookie', () => {
    assert.equal(cookieUrl({ host: '.example.com', secure: true, path: '/a' }), 'https://example.com/a');
    assert.equal(cookieUrl({ host: 'plain.test', secure: false, path: '' }), 'http://plain.test/');
    assert.deepEqual(setDetails(cookie()), {
      url: 'https://example.com/',
      name: 'sid',
      value: 'v',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: T0 / 1000 + 86400,
    });
    const hostOnly = setDetails(cookie({ host: 'a.test', hostOnly: true, path: '', sameSite: 'bogus', secure: 0, httpOnly: 0 }));
    assert.equal('domain' in hostOnly, false);
    assert.equal(hostOnly.path, '/');
    assert.equal(hostOnly.sameSite, 'unspecified');
    assert.equal(hostOnly.secure, false);
    assert.equal(hostOnly.httpOnly, false);
  });

  test('writeCookies: sets each cookie, counts the ones Chromium refuses, stops when no longer current, always flushes', async () => {
    const ses = fakeSession();
    const out = await writeCookies(ses, [cookie({ name: 'a' }), cookie({ name: 'bad' }), cookie({ name: 'c' })]);
    assert.deepEqual([out.imported, out.failed, out.written.map((c: any) => c.name)], [2, 1, ['a', 'c']]);
    assert.deepEqual(ses.log.at(-1), ['flush']);
    const ses2 = fakeSession();
    let n = 0;
    const stopped = await writeCookies(ses2, [cookie({ name: 'a' }), cookie({ name: 'b' })], { isCurrent: () => n++ < 1 });
    assert.equal(stopped.imported, 1);
  });

  test('ImportLedger: records what an import wrote per site, lists it, removes it, and survives a restart', async () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'ledger.json');
    let clock = T0;
    const ledger = new ImportLedger({ file, now: () => clock });
    assert.deepEqual(ledger.sites(), []);
    assert.equal(ledger.last(), null);
    ledger.recordCookies(
      'chrome',
      [
        cookie({ name: 'a' }),
        cookie({ name: 'b', host: 'docs.example.com', path: '' }),
        cookie({ name: 'c', host: '.other.test', secure: false }),
      ],
      siteOf,
    );
    ledger.recordLast({ source: 'chrome', profile: 'Default', results: { cookies: { status: 'ok' } } });
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'private');
    const again = new ImportLedger({ file, now: () => clock });
    assert.deepEqual(again.sites(), [
      { site: 'example.com', source: 'chrome', importedAt: T0, count: 2 },
      { site: 'other.test', source: 'chrome', importedAt: T0, count: 1 },
    ]);
    assert.equal(again.last().source, 'chrome');
    assert.equal(again.last().at, T0);
    const ses = fakeSession();
    assert.equal(await again.remove(ses, 'example.com'), 2);
    assert.deepEqual(
      ses.log.filter((l: any) => l[0] === 'remove').map((l: any) => l[1]),
      ['https://example.com/', 'https://docs.example.com/'],
    );
    assert.equal(await again.remove(ses, 'not-imported.test'), 0);
    assert.equal(again.sites().length, 1);
    // Refused removals remain recorded so the user can retry, including after a restart.
    again.recordCookies('safari', [cookie({ name: 'stuck', host: '.s.test' })], siteOf);
    await assert.rejects(again.remove(ses), /1.*could not be removed.*Try again/i);
    assert.deepEqual(again.sites(), [{ site: 's.test', source: 'safari', importedAt: T0, count: 1 }]);
    assert.deepEqual(new ImportLedger({ file }).sites(), again.sites());
    ses.cookies.remove = async () => {};
    assert.equal(await again.remove(ses), 1);
    assert.deepEqual(new ImportLedger({ file }).sites(), []);
  });

  test('ImportLedger: a missing or damaged file is an empty ledger', () => {
    const dir = tmp();
    const file = path.join(dir, 'l.json');
    assert.deepEqual(new ImportLedger({ file }).sites(), []);
    fs.writeFileSync(file, 'not json');
    assert.deepEqual(new ImportLedger({ file }).sites(), []);
    fs.writeFileSync(file, JSON.stringify({ cookies: null, last: undefined }));
    const l = new ImportLedger({ file });
    assert.deepEqual(l.sites(), []);
    assert.equal(l.last(), null);
  });
}

export function registerRepeatedImport() {
  test('ImportLedger: importing a site again keeps what an earlier import wrote, so removal deletes both', async () => {
    const dir = tmp();
    const ledger = new ImportLedger({ file: path.join(dir, 'l.json'), now: () => T0 });
    ledger.recordCookies('chrome', [cookie({ name: 'a' }), cookie({ name: 'b' })], siteOf);
    ledger.recordCookies('chrome', [cookie({ name: 'b' }), cookie({ name: 'c' })], siteOf);
    assert.equal(ledger.sites()[0].count, 3);
    const ses = fakeSession();
    assert.equal(await ledger.remove(ses, 'example.com'), 3);
  });
}

export function registerLedgerFailures() {
  test('ImportLedger keeps committed state after failed cookie, summary and removal saves', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const ledger = new ImportLedger({ file, now: () => T0 });
    ledger.recordCookies('chrome', [cookie({ name: 'original' })], siteOf);
    ledger.recordLast({ source: 'chrome' });
    const before = fs.readFileSync(file, 'utf8');
    const last = ledger.last();
    const rename = t.mock.method(fs, 'renameSync', () => {
      throw new Error('disk full');
    });
    assert.throws(() => ledger.recordCookies('safari', [cookie({ host: '.new.test' })], siteOf), /disk full/);
    assert.equal(ledger.sites().length, 2, 'actual cookie writes remain visible as recovery targets');
    assert.throws(() => ledger.recordLast({ source: 'safari' }), /disk full/);
    assert.deepEqual(ledger.last(), last);
    await assert.rejects(ledger.remove(fakeSession()), /disk full/);
    assert.equal(ledger.sites().length, 2, 'failed removal persistence retains all cleanup targets');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    rename.mock.restore();
    assert.equal(await ledger.remove(fakeSession()), 2, 'retry still knows what to remove');
    assert.deepEqual(ledger.sites(), []);
    assert.deepEqual(new ImportLedger({ file }).sites(), []);
  });

  test('ImportLedger retains removal targets after a cookie-store flush fails', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const ledger = new ImportLedger({ file });
    ledger.recordCookies('chrome', [cookie()], siteOf);
    const original = fs.readFileSync(file, 'utf8');
    const ses = fakeSession();
    ses.cookies.flushStore = async () => {
      throw new Error('flush refused');
    };
    await assert.rejects(ledger.remove(ses), /flush refused/);
    assert.equal(ledger.sites()[0].count, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('ImportLedger removal cannot erase a newer import recorded while a session operation waits', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const ledger = new ImportLedger({ file, now: () => T0 });
    ledger.recordCookies('chrome', [cookie({ name: 'old' })], siteOf);
    const ses = fakeSession();
    let release!: () => void;
    ses.cookies.remove = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const removing = ledger.remove(ses);
    await new Promise((resolve) => setImmediate(resolve));
    ledger.recordCookies('safari', [cookie({ name: 'new' })], siteOf);
    ledger.recordLast({ source: 'safari' });
    release();
    assert.equal(await removing, 1);
    assert.equal(ledger.sites()[0].source, 'safari');
    assert.equal(ledger.sites()[0].count, 1, 'completed old targets retire without erasing the newer cleanup target');
    assert.equal(new ImportLedger({ file }).last().source, 'safari');
    assert.deepEqual(new ImportLedger({ file }).sites(), ledger.sites());
  });

  test('ImportLedger persists only failed targets and reports plural refusals before a successful retry', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const ledger = new ImportLedger({ file });
    ledger.recordCookies('chrome', [cookie({ name: 'good' }), cookie({ name: 'bad-a' }), cookie({ name: 'bad-b' })], siteOf);
    const ses = fakeSession();
    ses.cookies.remove = async (_url: string, name: string) => {
      if (name.startsWith('bad')) throw new Error('busy');
    };
    await assert.rejects(ledger.remove(ses), /2 imported cookies could not be removed.*Try again/);
    assert.equal(ledger.sites()[0].count, 2);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')).cookies['example.com'].entries.map((e: any[]) => e[1]),
      ['bad-a', 'bad-b'],
    );
    ses.cookies.remove = async () => {};
    assert.equal(await ledger.remove(ses), 2);
    assert.deepEqual(new ImportLedger({ file }).sites(), []);
  });

  test('ImportLedger site names use owned keys, including names shared with Object.prototype', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const ledger = new ImportLedger({ file });
    const ses = fakeSession();
    assert.equal(await ledger.remove(ses, 'constructor'), 0, 'an inherited property is not an imported site');
    ledger.recordCookies('chrome', [cookie({ host: '__proto__', name: 'kept' })], siteOf);
    ledger.recordCookies('chrome', [cookie({ host: '__proto__', name: 'also-kept' })], siteOf);
    assert.equal(ledger.sites()[0].site, '__proto__');
    assert.equal(ledger.sites()[0].count, 2);
    const again = new ImportLedger({ file });
    ses.cookies.remove = async () => {
      throw new Error('busy');
    };
    await assert.rejects(again.remove(ses), /2 imported cookies could not be removed/);
    assert.equal(new ImportLedger({ file }).sites()[0].count, 2);
    ses.cookies.remove = async () => {};
    assert.equal(await again.remove(ses), 2);
    assert.deepEqual(again.sites(), []);
  });
}

export function registerStaleRemoval() {
  test('ImportLedger stops stale per-cookie work when a direct newer record replaces site ownership', async (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new ImportLedger({ file: path.join(dir, 'ledger.json') });
    const ses = fakeSession();
    const old = [cookie({ name: 'a', value: 'old-a' }), cookie({ name: 'b', value: 'old-b' })];
    for (const c of old) await ses.cookies.set(setDetails(c));
    ledger.recordCookies('chrome', old, siteOf);
    const originalRemove = ses.cookies.remove;
    let release!: () => void;
    ses.cookies.remove = async (url: string, name: string) => {
      if (name === 'a')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await originalRemove(url, name);
    };
    const removing = ledger.remove(ses);
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = cookie({ name: 'b', value: 'fresh' });
    await ses.cookies.set(setDetails(fresh));
    ledger.recordCookies('safari', [fresh], siteOf);
    release();
    assert.equal(await removing, 1);
    assert.equal([...ses.stored.values()][0].value, 'fresh');
    assert.deepEqual(
      ledger.sites().map((s: any) => [s.source, s.count]),
      [['safari', 1]],
    );
  });
}

export function registerWriteFailure() {
  test('writeCookies hands off successful writes on flush failure and preserves that error if bookkeeping also fails', async () => {
    const ses = fakeSession();
    const failure = new Error('original flush failure');
    ses.cookies.flushStore = async () => {
      throw failure;
    };
    let written: any[] = [];
    await assert.rejects(
      writeCookies(ses, [cookie()], {
        onWritten: (targets: any[]) => {
          written = targets;
          throw new Error('bookkeeping refused');
        },
      }),
      (error: any) => error === failure,
    );
    assert.equal(written.length, 1);
    assert.equal(ses.stored.size, 1);
  });
}
