// Migration collaborators for the fake main process: stable app/profile identities, recorded migration outcomes and cookie re-encryption.
import path from 'node:path';
import edition from '../../shared/edition.json' with { type: 'json' };

export const fixtureProfile = (appData: string) => path.join(appData, edition.desktop.profile);

/** Fresh migration mocks for one main-process load, using the harness's own mock function factory. */
export function mainMigrations(fn: (impl?: (...args: any[]) => any) => any) {
  return {
    'electron/migrations/migrate.cjs': {
      APP_NAME: edition.desktop.name,
      STORAGE_NAME: edition.desktop.profile,
      userDataDir: fn(fixtureProfile),
      migrateUserData: fn(),
      runMigrations: fn(() => [{ id: 'threads-v2', result: 'ok' }]),
      retryMigration: fn(() => ({ id: 'threads-v2', result: 'ok' })),
      migrationReport: fn(() => 'report'),
      restoreMigration: fn(() => ({ id: 'threads-v2', report: 'r' })),
      lastEntry: fn(() => ({ result: 'ok' })),
      readRegistry: fn(() => 'registry'),
      record: fn(),
    },
    'electron/migrations/2026-10-cookies.cjs': {
      id: '2026-10-cookies',
      migrateCookies: fn(() => ({ result: 'ok', decrypted: 1, failed: 0, reencrypt: false, backup: 'b' })),
      reencryptSession: fn(async () => 2),
    },
  };
}
