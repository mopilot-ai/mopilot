// #2144: the built-in browser's history an earlier version kept as a plain SQLite database is moved into the sealed
// history at its first use (the address bar's suggestions read it), the plain database and its journal are deleted,
// and after quitting nothing on disk names a page that was visited.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from './fixtures/app';

const PAGE = 'https://private-history.example.test/account';

test.describe('browser history at rest', () => {
  test.use({
    seed: {
      files: (d) => {
        const db = new DatabaseSync(path.join(d.userData, 'browser-history.sqlite'));
        db.exec(
          "PRAGMA journal_mode = WAL; CREATE TABLE urls (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'local')",
        );
        db.prepare('INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, 3, ?)').run(
          PAGE,
          'Private account page',
          Date.now(),
        );
        db.close();
      },
    },
  });

  test('a plain history is sealed at first use and nothing readable names the page after quit', async ({ page, harness }) => {
    const ud = path.join(harness.dir, 'userData');
    const plain = path.join(ud, 'browser-history.sqlite');
    expect(fs.existsSync(plain)).toBe(true);
    // the address bar's suggestions open the history
    const found = await page.evaluate(() => (window as any).native.browser.suggest('private-history'));
    expect(JSON.stringify(found)).toContain('private-history.example.test');
    for (const f of [plain, `${plain}-wal`, `${plain}-shm`]) await expect.poll(() => fs.existsSync(f), { message: f }).toBe(false);
    const sealed = path.join(ud, 'browser-history.sqlite.enc');
    // owner-only bits: Windows has none to read (a file there reports 0o666 whatever its ACL)
    if (process.platform !== 'win32') expect(fs.statSync(sealed).mode & 0o777).toBe(0o600);
    await harness.quit();
    const named = fs
      .readdirSync(ud)
      .filter((f) => f.startsWith('browser-history'))
      .filter((f) => fs.readFileSync(path.join(ud, f)).includes('private-history.example.test'));
    expect(named).toEqual([]);
    // the next start reads it back
    await harness.relaunch();
    const again = await harness.page.evaluate(() => (window as any).native.browser.suggest('private-history'));
    expect(JSON.stringify(again)).toContain('private-history.example.test');
  });
});
