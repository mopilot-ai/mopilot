// The cookie migration's step 3 at startup (#2144, electron/app/lifecycle.cjs migrateCookies): once its cookies were
// re-encrypted, the plaintext step 1 left in the databases' free pages is scrubbed before Chromium opens them; a
// failed scrub is tried again at the next starts, three times in all; one that worked is not run again; and a second
// launch takes the single-instance lock before any of it.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
import edition from '../shared/edition.json' with { type: 'json' };

const { recentIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const desktop: { legacyProfiles: string[] } = edition.desktop;
const originalProfiles = desktop.legacyProfiles;
test.before(() => {
  desktop.legacyProfiles = ['Sage Codex'];
});
after(() => {
  unloadMain();
  desktop.legacyProfiles = originalProfiles;
});
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
const RE = '2026-10-cookies-reencrypt';
const SCRUB = '2026-10-cookies-scrub';

/** The migration's entry and the attempts recorded so far; `scrub` is the module's scrub. */
const entries =
  (tries: any[], scrub = mock.fn()) =>
  (h: any) => {
    h.mod('migrations/migrate.cjs').lastEntry.mock.mockImplementation((_ud: string, id: string) =>
      id === '2026-10-cookies' ? { reencrypt: true, backup: '/ud/backups/cookies-x' } : (tries.at(-1) ?? null),
    );
    h.mod('migrations/migrate.cjs').readRegistry.mock.mockImplementation(() => [{ id: '2026-10-cookies', reencrypt: true }, ...tries]);
    h.mod('migrations/2026-10-cookies.cjs').scrubDbs = scrub;
  };
const recorded = (h: any) => calls(h.mod('migrations/migrate.cjs').record).find((c: any) => c[1].id === SCRUB)?.[1];

test('cookie scrub: after a successful re-encryption, once; a failed one again, three times in all', async () => {
  const ok = { id: RE, result: 'ok' };
  let scrub: any = mock.fn();
  let h = await loadMain({ before: entries([{ id: RE, result: 'error' }, ok], scrub) });
  assert.equal(scrub.mock.callCount(), 1);
  assert.deepEqual(scrub.mock.calls[0].arguments.slice(1), ['/ud/backups/cookies-x']);
  assert.equal(recorded(h).result, 'ok');
  scrub = mock.fn(() => {
    throw new Error('database is locked');
  });
  h = await loadMain({ before: entries([ok, { id: SCRUB, result: 'error' }], scrub) });
  assert.equal(scrub.mock.callCount(), 1);
  assert.deepEqual({ ...recorded(h), at: 0 }, { id: SCRUB, result: 'error', message: 'database is locked', at: 0 });
  scrub = mock.fn();
  await loadMain({ before: entries([ok, ...Array(3).fill({ id: SCRUB, result: 'error' })], scrub) });
  assert.equal(scrub.mock.callCount(), 0);
  await loadMain({ before: entries([ok, { id: SCRUB, result: 'ok' }], scrub) });
  assert.equal(scrub.mock.callCount(), 0);
  // not re-encrypted yet, with tries left: nothing to scrub
  await loadMain({ before: entries([{ id: RE, result: 'error' }], scrub) });
  assert.equal(scrub.mock.callCount(), 0);
  // re-encryption out of tries: the scrub runs anyway, so plain cookies never stay; it is given step 1's backup
  scrub = mock.fn(() => 2);
  h = await loadMain({ before: entries(Array(3).fill({ id: RE, result: 'error' }), scrub) });
  assert.equal(scrub.mock.callCount(), 1);
  assert.deepEqual({ ...recorded(h), at: 0 }, { id: SCRUB, result: 'ok', plain: 2, at: 0 });
});

test('a second launch takes the single-instance lock before the cookie migration looks at the databases', async () => {
  const order: string[] = [];
  await loadMain({
    before: (h: any) => {
      h.app.requestSingleInstanceLock = () => (order.push('lock'), true);
      h.mod('migrations/migrate.cjs').lastEntry.mock.mockImplementation((_ud: string, id: string) => {
        if (id === '2026-10-cookies') order.push('cookies');
        return { result: 'ok' };
      });
    },
  });
  assert.deepEqual(order.slice(0, 2), ['lock', 'cookies']);
});

test('cookie migration: runs once on macOS and records the result', async () => {
  const cookies = (r: any) => ({
    before: (h: any) => (
      h.mod('migrations/migrate.cjs').lastEntry.mock.mockImplementation(() => null),
      h.mod('migrations/2026-10-cookies.cjs').migrateCookies.mock.mockImplementation(r)
    ),
  });
  let h = await loadMain(cookies(() => ({ result: 'ok', decrypted: 3, failed: 0, reencrypt: true, backup: 'bk' })));
  const rec = calls(h.mod('migrations/migrate.cjs').record)[0];
  assert.equal(rec[0], h.userData);
  assert.deepEqual(
    { ...rec[1], at: 0 },
    { id: '2026-10-cookies', result: 'ok', decrypted: 3, failed: 0, reencrypt: true, backup: 'bk', at: 0 },
  );
  await h.ready();
  await flush();
  // carried-over cookies are stored again with this build's key, in both sessions
  const sessions = calls(h.mod('migrations/2026-10-cookies.cjs').reencryptSession).map((c: any) => c[0].name);
  assert.deepEqual(sessions, ['default', 'persist:browser']);
  const re = calls(h.mod('migrations/migrate.cjs').record).find((c: any) => c[1].id === '2026-10-cookies-reencrypt');
  assert.equal(re[1].cookies, 4);
  assert.deepEqual(await h.invoke('migration:status'), [{ id: 'threads-v2', result: 'ok' }]);

  h = await loadMain(cookies(() => ({ result: 'failed', decrypted: 0, failed: 5, reencrypt: false })));
  await h.ready();
  assert.deepEqual((await h.invoke('migration:status')).at(-1), { id: '2026-10-cookies', result: 'failed', reason: '5 cookies' });

  h = await loadMain(
    cookies(() => {
      throw new Error('keychain locked');
    }),
  );
  assert.equal(calls(h.mod('migrations/migrate.cjs').record)[0][1].result, 'error');
  await h.ready();
  assert.deepEqual((await h.invoke('migration:status')).at(-1), { id: '2026-10-cookies', result: 'error', reason: 'keychain locked' });

  h = await loadMain(
    cookies(() => {
      throw 'plain';
    }),
  );
  assert.equal(calls(h.mod('migrations/migrate.cjs').record)[0][1].message, 'plain');
});

test('cookie re-encryption: only once, a failing one is an error tried again at the next starts (three in all), and Windows never had the cookies', async () => {
  const RE = '2026-10-cookies-reencrypt';
  // the migration's entry, and the re-encryption attempts recorded so far
  const entries =
    (tries: any[] = []) =>
    (h: any) => {
      h.mod('migrations/migrate.cjs').lastEntry.mock.mockImplementation((_ud: string, id: string) =>
        id === '2026-10-cookies' ? { reencrypt: true } : (tries.at(-1) ?? null),
      );
      h.mod('migrations/migrate.cjs').readRegistry.mock.mockImplementation(() => [{ id: '2026-10-cookies', reencrypt: true }, ...tries]);
    };
  const reencrypted = (h: any) => h.mod('migrations/2026-10-cookies.cjs').reencryptSession.mock.callCount();
  let h = await loadMain({
    before: (h) => {
      entries()(h);
      h.mod('migrations/2026-10-cookies.cjs').reencryptSession.mock.mockImplementation(async (s: any) =>
        s.name === 'default' ? 2 : Promise.reject(new Error('locked')),
      );
    },
  });
  await h.ready();
  await flush();
  const failed = calls(h.mod('migrations/migrate.cjs').record).find((c: any) => c[1].id === RE)[1];
  assert.deepEqual({ ...failed, at: 0 }, { id: RE, result: 'error', cookies: 2, message: 'locked', at: 0 });
  // the failed attempt is not counted as done: the next start tries again
  const error = { id: RE, result: 'error' };
  h = await loadMain({ before: entries([error, error]) });
  await h.ready();
  await flush();
  assert.equal(reencrypted(h), 2);
  // after the third failure it is left alone
  h = await loadMain({ before: entries([error, error, error]) });
  await h.ready();
  assert.equal(reencrypted(h), 0);
  h = await loadMain({ before: entries([error, { id: RE, result: 'ok' }]) });
  await h.ready();
  assert.equal(reencrypted(h), 0);
  // a result that cannot be recorded is noted
  h = await loadMain({
    before: (h) => {
      entries()(h);
      h.mod('migrations/migrate.cjs').record.mock.mockImplementation(() => {
        throw new Error('disk full');
      });
    },
  });
  await h.ready();
  await flush();
  assert.ok(recentIgnored().some((e: any) => e.context === 'record the cookie re-encryption' && e.message === 'disk full'));
  // a fresh Windows profile has no entry at all
  h = await loadMain({
    platform: 'win32',
    before: (h: any) => h.mod('migrations/migrate.cjs').lastEntry.mock.mockImplementation(() => null),
  });
  assert.equal(h.mod('migrations/2026-10-cookies.cjs').migrateCookies.mock.callCount(), 0);
  await h.ready();
  assert.equal(reencrypted(h), 0);
});
