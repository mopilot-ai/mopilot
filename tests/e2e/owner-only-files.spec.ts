// #2144: a profile an earlier version left readable by other users (files 0644, folders 0755) is made owner-only at
// start, a harness's home is closed without walking into it, and what the app writes afterwards is owner-only too.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'Chromium on Linux writes spellcheck dictionaries into the profile');

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test.describe('owner-only data folder', () => {
  test.use({
    seed: {
      files: (d) => {
        const open = (rel: string, body = '{}') => {
          const p = path.join(d.userData, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, body);
          fs.chmodSync(p, 0o644);
          return p;
        };
        open('threads/legacy.v2');
        open('turn-diffs/0123abcd.json'); // per-chat saved turn diffs (#2559); the old whole-store file is migrated away
        open('capabilities/browser-uploads/chat_1/scan.jpg', 'jpeg');
        open('capabilities/computer.json');
        open('accounts/home1/logs_2.sqlite', 'codex-owned');
        for (const dir of [
          'threads',
          'turn-diffs',
          'capabilities',
          'capabilities/browser-uploads',
          'capabilities/browser-uploads/chat_1',
          'accounts',
          'accounts/home1',
        ])
          fs.chmodSync(path.join(d.userData, dir), 0o755);
        fs.chmodSync(d.userData, 0o755);
      },
    },
  });

  test('files and folders become 0600/0700 at start; a harness home is closed, not walked', async ({ page, harness }) => {
    const ud = path.join(harness.dir, 'userData');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await expect.poll(() => mode(path.join(ud, 'threads', 'legacy.v2')), { timeout: 20_000 }).toBe(0o600);
    expect(mode(ud)).toBe(0o700);
    for (const f of ['turn-diffs/0123abcd.json', 'capabilities/browser-uploads/chat_1/scan.jpg', 'capabilities/computer.json'])
      expect(mode(path.join(ud, f)), f).toBe(0o600);
    for (const dir of ['threads', 'turn-diffs', 'capabilities', 'capabilities/browser-uploads/chat_1', 'accounts', 'accounts/home1'])
      expect(mode(path.join(ud, dir)), dir).toBe(0o700);
    expect(mode(path.join(ud, 'accounts', 'home1', 'logs_2.sqlite')), 'what Codex keeps in its home is its own').toBe(0o644);
    // what the app writes from here on is owner-only: every regular file it wrote is
    const loose: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (['accounts', 'Cache', 'Code Cache', 'GPUCache', 'Partitions', 'Crashpad'].includes(e.name) && dir === ud) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && fs.statSync(p).mode & 0o077) loose.push(path.relative(ud, p));
      }
    };
    walk(ud);
    expect(loose).toEqual([]);
  });
});
