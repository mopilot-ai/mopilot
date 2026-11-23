// Browser import passwords cases using shared fake sessions, storage, and readers.
import { test, assert, fs, ImportError, world } from './fixture.ts';

export function registerPasswords() {
  test('passwords: read with the same key as cookies, listed per site, saved into the login store for the chosen sites only', async () => {
    const w = world();
    const s = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true, passwords: true } });
    assert.equal(w.calls.filter((c: any) => c[0] === 'key').length, 1, 'one keychain prompt for both');
    assert.deepEqual(
      s.sites.map((x: any) => [x.site, x.count, x.logins]),
      [
        ['chase.com', 1, 1],
        ['example.com', 1, 1],
        ['news.test', 1, 0],
      ],
    );
    const r = await w.importer.run({ jobId: s.jobId, sites: ['example.com'] });
    assert.deepEqual(r.passwords, { status: 'ok', imported: 1, replaced: 0, sites: 1 });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(w.loginStore.file, 'utf8')).map((l: any) => [l.origin, l.username, l.source]),
      [['https://www.example.com', 'me', 'import:chrome']],
    );
    assert.deepEqual(w.importer.imported().passwords, [{ source: 'chrome', count: 1 }]);
    assert.equal(w.importer.deletePasswords('chrome'), 1);
    // passwords only: no cookie read
    const p = world();
    const sp = await p.importer.start({ source: 'chrome', profile: 'Default', kinds: { passwords: true } });
    assert.deepEqual(
      p.calls.map((c: any) => c[1]),
      ['Chrome Safe Storage', 'passwords'],
    );
    assert.deepEqual(
      sp.sites.map((x: any) => x.site),
      ['chase.com', 'example.com'],
    );
  });

  test('passwords: a denied key fails cookies and passwords alike; a failed password read fails only passwords; no encryption saves nothing', async () => {
    const denied = world({ keyError: new ImportError('keychain_denied', 'no') });
    const a = await denied.importer.start({
      source: 'chrome',
      profile: 'Default',
      kinds: { cookies: true, passwords: true, history: true },
    });
    assert.deepEqual(a.failed, { cookies: 'keychain_denied', passwords: 'keychain_denied' });
    assert.deepEqual(a.sites, []);
    const ra = await denied.importer.run({ jobId: a.jobId });
    assert.deepEqual([ra.cookies.status, ra.passwords.status, ra.history.status], ['failed', 'failed', 'ok']);
    const broken = world({ passwords: () => Promise.reject(new ImportError('missing', 'no file')) });
    const b = await broken.importer.start({ source: 'chrome', profile: 'Default', kinds: { cookies: true, passwords: true } });
    assert.deepEqual(b.failed, { passwords: 'missing' });
    assert.equal(b.sites.length, 3);
    broken.importer.cancel(b.jobId);
    const plain = world({ noSafe: true });
    const c = await plain.importer.start({ source: 'chrome', profile: 'Default', kinds: { passwords: true } });
    assert.deepEqual((await plain.importer.run({ jobId: c.jobId, sites: ['example.com'] })).passwords, {
      status: 'failed',
      code: 'storage_unavailable',
    });
  });

  test('passwords: cancelling while the key is read or while passwords are read ends the job', async () => {
    let release: () => void = () => {};
    const w = world({ keyHook: () => new Promise<void>((r) => (release = r)) });
    const started = w.importer.start({ source: 'chrome', profile: 'Default', kinds: { passwords: true } });
    await new Promise((r) => setImmediate(r));
    w.importer.cancel(w.importer.job.id);
    release();
    await assert.rejects(started, { code: 'cancelled' });
    let finish: (v: any) => void = () => {};
    const v = world({ passwords: () => new Promise((r) => (finish = r)) });
    const s2 = v.importer.start({ source: 'chrome', profile: 'Default', kinds: { passwords: true } });
    await new Promise((r) => setImmediate(r));
    v.importer.cancel(v.importer.job.id);
    finish({ logins: [], stats: {} });
    await assert.rejects(s2, { code: 'cancelled' });
    assert.equal(v.importer.job, null);
  });

  test("Safari passwords: read from the file the user chose, which needs no Full Disk Access when it is all that's asked", async () => {
    const blockedSafari = {
      id: 'safari',
      name: 'Safari',
      kind: 'safari',
      keychainService: null,
      status: 'needs_full_disk_access',
      profiles: [{ id: 'Safari', name: 'Safari', path: '/s' }],
    };
    const { importer, calls, files, loginStore } = world({ sources: [blockedSafari] });
    assert.equal(importer.passwordFile, null);
    importer.setPasswordFile('/Users/me/Downloads/Passwords.csv');
    const s = await importer.start({ source: 'safari', profile: 'Safari', kinds: { passwords: true } });
    assert.deepEqual(files, ['/Users/me/Downloads/Passwords.csv']);
    assert.ok(!calls.some((c: any[]) => c[0] === 'key'), 'no keychain prompt');
    const out = await importer.run({ jobId: s.jobId, sites: s.sites.map((x: any) => x.site) });
    assert.equal(out.passwords.status, 'ok');
    assert.deepEqual(loginStore.importedSources(), [{ source: 'safari', count: 2 }]);
    // anything else from Safari still needs Full Disk Access
    for (const kinds of [
      { passwords: true, history: true },
      { passwords: true, bookmarks: true },
      { passwords: true, cookies: true },
      { history: true },
    ])
      await assert.rejects(() => importer.start({ source: 'safari', profile: 'Safari', kinds }), { code: 'access_blocked' });
    await assert.rejects(() => importer.start({ source: 'safari', profile: 'Safari' }), { code: 'access_blocked' });
    // forgetting the file: the reader is told there is none
    importer.setPasswordFile(null);
    assert.equal(importer.passwordFile, null);
    importer.setPasswordFile('');
    assert.equal(importer.passwordFile, null);
    const again = await importer.start({ source: 'safari', profile: 'Safari', kinds: { passwords: true } });
    assert.equal(files.at(-1), null);
    importer.cancel(again.jobId);
    // a Chrome profile that needs Full Disk Access gets no such exception
    const { importer: chromeOnly } = world();
    await assert.rejects(() => chromeOnly.start({ source: 'blocked', profile: 'Default', kinds: { passwords: true } }), {
      code: 'access_blocked',
    });
  });
}
