// Browser import imports cases using shared fake sessions, storage, and readers.
import { test, assert, fs, path, siteOf, setDetails, ImportLedger, KINDS, ImportError, cookie, world } from './fixture.ts';

export function registerImports() {
  test('sources: what each browser can bring (Arc keeps its bookmarks elsewhere)', () => {
    const { importer } = world();
    const byId = Object.fromEntries(importer.sources().map((s: any) => [s.id, s.kinds]));
    assert.deepEqual(byId.chrome, { bookmarks: true, history: true, cookies: true, passwords: true });
    assert.deepEqual(byId.arc, { bookmarks: false, history: true, cookies: true, passwords: true });
    assert.deepEqual(byId.safari, { bookmarks: true, history: true, cookies: true, passwords: true });
    // Safari's passwords come from a file the user exports; the others' from the profile
    assert.deepEqual(
      importer.sources().map((s: any) => [s.id, s.passwordFile]),
      [
        ['chrome', false],
        ['arc', false],
        ['safari', true],
        ['old', false],
        ['blocked', false],
      ],
    );
    assert.deepEqual(KINDS, ['bookmarks', 'history', 'cookies', 'passwords']);
  });

  test('start and run: a Chromium import reads the key once, lists the sites, writes the chosen ones and reports every category', async () => {
    const { importer, data, ses, calls, events, keyBuf } = world();
    const started = await importer.start({
      source: 'chrome',
      profile: 'Default',
      kinds: { bookmarks: true, history: true, cookies: true },
    });
    assert.deepEqual(started.failed, {});
    assert.deepEqual(
      started.sites.map((s: any) => [s.site, s.sensitive]),
      [
        ['chase.com', true],
        ['example.com', false],
        ['news.test', false],
      ],
    );
    assert.deepEqual(keyBuf, Buffer.alloc(16), 'the key is wiped once it was used');
    assert.deepEqual(calls.slice(0, 2), [
      ['key', 'Chrome Safe Storage'],
      ['chromium', 'cookies', 'Default', 'key'],
    ]);
    // a job still waiting for the user's choice (its dialog was lost) gives way to a new one, and its id goes stale
    const second = await importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } });
    await assert.rejects(() => importer.run({ jobId: started.jobId, sites: ['example.com'] }), { code: 'cancelled' });
    importer.cancel(second.jobId);
    const again = await importer.start({ source: 'chrome', profile: 'Default', kinds: { bookmarks: true, history: true, cookies: true } });
    assert.equal(again.sites.length, 3);
    Object.assign(started, again);
    const results = await importer.run({ jobId: started.jobId, sites: ['example.com', 'news.test'] });
    assert.deepEqual(results, {
      bookmarks: { status: 'ok', imported: 1, skippedExisting: 0, skippedInvalid: 0 },
      history: { status: 'ok', imported: 1, skippedExisting: 0, skippedInvalid: 0 },
      cookies: { status: 'ok', imported: 2, failed: 0, sites: 2 },
    });
    assert.deepEqual(
      ses.log.filter((l: any) => l[0] === 'set').map((l: any) => l[1]),
      ['a', 'c'],
      'the unchecked bank was not written',
    );
    assert.deepEqual(
      events.map((e: any) => [e[0], e[1].kind, e[1].result.status]),
      [
        ['browser:importProgress', 'bookmarks', 'ok'],
        ['browser:importProgress', 'history', 'ok'],
        ['browser:importProgress', 'cookies', 'ok'],
      ],
    );
    assert.equal(data.bookmarks().list()[0].folderPath[0], 'Imported from Google Chrome');
    assert.equal(data.history().count(), 1);
    const summary = importer.imported();
    assert.deepEqual(summary.history, [{ source: 'chrome', count: 1 }]);
    assert.deepEqual(summary.bookmarks, [{ source: 'chrome', count: 1 }]);
    assert.deepEqual(
      summary.cookies.map((c: any) => c.site),
      ['example.com', 'news.test'],
    );
    assert.equal(summary.last.source, 'chrome');
    // the job is over: a new one can start, and the old id is stale
    await assert.rejects(() => importer.run({ jobId: started.jobId }), { code: 'cancelled' });
    const next = await importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } });
    assert.deepEqual(next.sites, []);
    assert.equal(importer.cancel('other'), false);
    assert.equal(importer.cancel(next.jobId), true);
    assert.equal(importer.cancel(next.jobId), false);
    // removing what was imported
    assert.equal(await importer.removeCookies('example.com'), 1);
    assert.equal(await importer.removeCookies(), 1);
    assert.equal(importer.deleteHistory('chrome'), 1);
    assert.equal(importer.deleteBookmarks(), 1);
    assert.deepEqual(importer.imported().cookies, []);
  });

  test('start: a Safari import needs no key; unknown, unready and empty requests are refused', async () => {
    const { importer, calls } = world();
    const s = await importer.start({ source: 'safari', profile: 'Safari', kinds: { cookies: true, history: false } });
    assert.equal(s.sites.length, 3);
    assert.deepEqual(calls[0], ['safari', 'cookies', 'Safari', 'nokey']);
    importer.cancel(s.jobId);
    const refuse = (req: any, code: string) => assert.rejects(() => importer.start(req), { code });
    await refuse({ source: 'nope', profile: 'x', kinds: { history: true } }, 'missing');
    await refuse({ source: 'chrome', profile: 'Profile 9', kinds: { history: true } }, 'missing');
    await refuse({ source: 'old', profile: 'Default', kinds: { history: true } }, 'unsupported');
    await refuse({ source: 'blocked', profile: 'Default', kinds: { history: true } }, 'access_blocked');
    await refuse({ source: 'chrome', profile: 'Default', kinds: {} }, 'unsupported');
    await refuse({ source: 'chrome', profile: 'Default' }, 'unsupported');
    await refuse({ source: 'arc', profile: 'Default', kinds: { bookmarks: true } }, 'unsupported');
  });

  test('a cookie step that fails (denied keychain, unreadable file) leaves the other categories to run', async () => {
    const denied = world({ keyError: new ImportError('keychain_denied', 'no') });
    const a = await denied.importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true, cookies: true } });
    assert.deepEqual(a.failed, { cookies: 'keychain_denied' });
    const ra = await denied.importer.run({ jobId: a.jobId });
    assert.deepEqual(ra.cookies, { status: 'failed', code: 'keychain_denied' });
    assert.equal(ra.history.status, 'ok');
    const unreadable = world({ cookies: () => Promise.reject(Object.assign(new Error('x'), { code: 'EPERM' })) });
    const b = await unreadable.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    assert.deepEqual(b.failed, { cookies: 'access_blocked' });
    unreadable.importer.cancel(b.jobId);
  });

  test("a category that fails to read or write is that category's failure, not the import's", async () => {
    const w = world({
      bookmarks: () => Promise.reject(new Error('broken plist')),
      history: () => Promise.reject(new ImportError('missing', 'gone')),
    });
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { bookmarks: true, history: true, cookies: true } });
    const r = await w.importer.run({ jobId: s.jobId, sites: ['example.com'] });
    assert.deepEqual(
      [r.bookmarks, r.history],
      [
        { status: 'failed', code: 'read_failed' },
        { status: 'failed', code: 'missing' },
      ],
    );
    assert.equal(r.cookies.status, 'ok');
  });
}

export function registerImportEdges() {
  test('an importer built without a progress listener still runs', async () => {
    const w = world({ noBroadcast: true });
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { history: true } });
    assert.equal((await w.importer.run({ jobId: s.jobId })).history.status, 'ok');
    assert.deepEqual(w.events, []);
  });

  test('cookies that fail to write are counted; zero chosen sites writes nothing', async () => {
    const w = world({ cookies: () => ({ cookies: [cookie({ name: 'bad' }), cookie({ name: 'ok' })], stats: {} }) });
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const r = await w.importer.run({ jobId: s.jobId, sites: ['example.com'] });
    assert.deepEqual(r.cookies, { status: 'ok', imported: 1, failed: 1, sites: 1 });
    const w2 = world();
    const s2 = await w2.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    assert.deepEqual((await w2.importer.run({ jobId: s2.jobId })).cookies, { status: 'ok', imported: 0, failed: 0, sites: 0 });
  });
}

export function registerCookieOwnership() {
  test('BrowserImporter retains cleanup ownership when cookies were written but the ledger save fails', async (t) => {
    const w = world();
    const ledger = w.importer.o.ledger;
    ledger.recordLast({ source: 'before' });
    const prior = fs.readFileSync(ledger.file, 'utf8');
    const start = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const originalRename = fs.renameSync;
    const rename = t.mock.method(fs, 'renameSync', (from: any, to: any) => {
      if (to === ledger.file) throw new Error('disk full');
      return originalRename(from, to);
    });
    await assert.rejects(w.importer.run({ jobId: start.jobId, sites: ['example.com'] }), /disk full/);
    assert.equal(w.ses.stored.size, 1, 'the physical cookie was written before ledger persistence failed');
    assert.equal(fs.readFileSync(ledger.file, 'utf8'), prior, 'the committed ledger stays intact');
    assert.equal(w.importer.imported().cookies[0].count, 1, 'the successful external write stays visible for cleanup');
    rename.mock.restore();
    assert.equal(await w.importer.removeCookies('example.com'), 1);
    assert.equal(w.ses.stored.size, 0);
    assert.deepEqual(w.importer.imported().cookies, []);
  });

  test('BrowserImporter orders a new physical cookie import after an older pending removal', async () => {
    const w = world({ cookies: async () => ({ cookies: [cookie({ name: 'b', value: 'new' })], stats: {} }) });
    const old = [cookie({ name: 'a', value: 'old-a' }), cookie({ name: 'b', value: 'old-b' })];
    for (const c of old) await w.ses.cookies.set(setDetails(c));
    w.importer.o.ledger.recordCookies('chrome', old, siteOf);
    const originalRemove = w.ses.cookies.remove;
    let release!: () => void;
    w.ses.cookies.remove = async (url: string, name: string) => {
      if (name === 'a')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await originalRemove(url, name);
    };
    const removing = w.importer.removeCookies('example.com');
    await new Promise((resolve) => setImmediate(resolve));
    const start = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const running = w.importer.run({ jobId: start.jobId, sites: ['example.com'] });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.equal(await removing, 2);
    assert.equal((await running).cookies.imported, 1);
    assert.equal([...w.ses.stored.values()][0]?.value, 'new', 'an old removal cannot delete a later physical import');
    assert.equal(w.importer.imported().cookies[0].count, 1);
  });
}

export function registerFlushFailure() {
  test('BrowserImporter keeps removable actual writes when flushing imported cookies fails', async () => {
    const w = world();
    w.ses.cookies.flushStore = async () => {
      throw new Error('flush refused');
    };
    const start = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true } });
    const results = await w.importer.run({ jobId: start.jobId, sites: ['example.com'] });
    assert.equal(results.cookies.status, 'failed');
    assert.equal(w.ses.stored.size, 1);
    assert.equal(w.importer.imported().cookies[0].count, 1);
    assert.equal(new ImportLedger({ file: w.importer.o.ledger.file }).sites()[0].count, 1);
    w.ses.cookies.flushStore = async () => {};
    assert.equal(await w.importer.removeCookies('example.com'), 1);
    assert.equal(w.ses.stored.size, 0);
  });
}

export function registerSavedVersion() {
  test('an unsupported saved import ledger blocks every category before browser data changes', async (t) => {
    const w = world();
    const ledger = w.importer.o.ledger;
    t.after(() => {
      w.importer.cancel(w.importer.job?.id);
      w.data.history().close();
      fs.rmSync(path.dirname(ledger.file), { recursive: true, force: true });
    });
    const original = JSON.stringify({ version: 2, cookies: {}, future: { retained: true } });
    fs.writeFileSync(ledger.file, original);
    const started = await w.importer.start({
      source: 'chrome',
      profile: 'Default',
      kinds: { bookmarks: true, history: true, cookies: true, passwords: true },
    });
    await assert.rejects(w.importer.run({ jobId: started.jobId, sites: ['example.com'] }), /newer version/i);
    assert.deepEqual(w.ses.log, []);
    assert.deepEqual(w.data.bookmarks().list(), []);
    assert.equal(w.data.history().count(), 0);
    assert.deepEqual(w.loginStore.importedSources(), []);
    assert.deepEqual(w.events, []);
    assert.equal(fs.readFileSync(ledger.file, 'utf8'), original);
  });
}
