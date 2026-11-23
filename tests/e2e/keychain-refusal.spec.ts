// #2144 follow-up: an added Codex account whose encrypted sign-in this Mac's key can't decrypt (the Keychain refused,
// or it was sealed under another key) says so when it is used, instead of "Your sign-in expired".
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';

test.describe('a sign-in the Keychain won’t decrypt', () => {
  test.use({
    seed: {
      files: (d) => {
        twoCodexAccounts(d);
        const home = path.join(d.userData, 'accounts', 'second');
        fs.rmSync(path.join(home, 'auth.json'));
        // a sealed sign-in no key on this machine opens
        fs.writeFileSync(path.join(home, 'auth.json.enc'), JSON.stringify({ v: 1, enc: 'safe', data: 'b3RoZXIga2V5' }), { mode: 0o600 });
      },
    },
  });

  test('switching to it names the Keychain', async ({ page }) => {
    await page.evaluate(() => (window as any).native.accounts.switchTo('second').catch(() => null));
    const second = async () =>
      (await page.evaluate(() => (window as any).native.accounts.list())).accounts.find((a: any) => a.id === 'second');
    await expect.poll(async () => (await second())?.error ?? '').toMatch(/couldn’t read this sign-in from the Keychain/);
    expect((await second()).status).toBe('expired');
  });
});
