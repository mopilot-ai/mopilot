// #2144: once the cookie migration's re-encryption has succeeded, the next start rewrites the cookie databases before
// Chromium opens them, so the plaintext its first step wrote is gone from their free pages, and records it once.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from './fixtures/app';

const SECRET = 'PLAINTEXT-SESSION-COOKIE-';

test.describe('cookie migration scrub', () => {
  test.use({
    seed: {
      files: (d) => {
        // a cookie database as step 1 left it: the value it stored in plain text replaced, but still in a free page
        const db = new DatabaseSync(path.join(d.userData, 'Cookies'));
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24')");
        db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)');
        db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('example.test', 'sid', SECRET.repeat(40), Buffer.alloc(0));
        db.exec("UPDATE cookies SET value = '', encrypted_value = X'763130'");
        // and one cookie step 2 never stored again: still plain
        db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('example.test', 'left', `${SECRET}left`, Buffer.alloc(0));
        db.close();
        const at = Date.now();
        fs.writeFileSync(
          path.join(d.userData, 'migrations.json'),
          JSON.stringify([
            { id: 'cookies-v1', result: 'ok', decrypted: 1, failed: 0, reencrypt: true, at },
            { id: 'cookies-v1-reencrypt', result: 'ok', cookies: 1, at },
          ]),
        );
      },
    },
  });

  test('the plaintext the migration left in free pages is gone after the next start, and the scrub is recorded', async ({
    page,
    harness,
  }) => {
    const ud = path.join(harness.dir, 'userData');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const registry = JSON.parse(fs.readFileSync(path.join(ud, 'migrations.json'), 'utf8'));
    expect(registry.filter((e: any) => e.id === 'cookies-v1-scrub').map((e: any) => e.result)).toEqual(['ok']);
    const leftovers = ['Cookies', 'Cookies-journal', 'Cookies-wal'].filter(
      (f) => fs.existsSync(path.join(ud, f)) && fs.readFileSync(path.join(ud, f)).includes(SECRET),
    );
    expect(leftovers).toEqual([]);
  });
});
