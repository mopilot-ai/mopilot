// #2144: secrets an earlier version left in plain text (an added Codex account's auth.json, the Claude API key, a
// base64 MoPilot sign-in) are encrypted at the first start and their plain copies deleted; the added account still
// runs a turn; and after quitting no secret is left readable anywhere in the profile.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';

const CLAUDE_KEY = 'sk-ant-fake-at-rest-7777';
const GATEWAY_KEY = 'mpk_fake_at_rest_gateway';
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

/** Every file under `dir` whose bytes contain `needle`, as paths relative to it. */
function filesContaining(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

test.describe('data at rest', () => {
  test.use({
    seed: {
      files: (d) => {
        twoCodexAccounts(d);
        fs.writeFileSync(path.join(d.userData, 'claude-api-key'), `${CLAUDE_KEY}\n`, { mode: 0o644 });
        const creds = { refreshToken: 'fake-refresh', gatewayKey: GATEWAY_KEY, user: { email: 'at-rest@example.test' }, deviceId: 'd' };
        fs.writeFileSync(
          path.join(d.userData, 'mopilot-auth.json'),
          JSON.stringify({ v: 1, enc: 'plain', data: Buffer.from(JSON.stringify(creds)).toString('base64') }),
        );
      },
    },
  });

  test('plain secrets are encrypted at start, the added account still runs, and none is readable after quit', async ({ page, harness }) => {
    const userData = path.join(harness.dir, 'userData');
    const second = path.join(userData, 'accounts', 'second');
    // the added account's access token as the seed wrote it in plain text (fixtures/codexAccounts.ts)
    const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-second', chatgpt_plan_type: 'plus' }, exp: 4e9 };
    const secondToken = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
    await expect.poll(() => fs.existsSync(path.join(userData, 'claude-api-key'))).toBe(false);
    // owner-only permission bits: Windows has none to read (a file there reports 0o666 whatever its ACL)
    const expectOwnerOnly = (file: string) => {
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    };
    const key = JSON.parse(fs.readFileSync(path.join(userData, 'claude-api-key.json'), 'utf8'));
    expect(key.enc).toBe('safe');
    expectOwnerOnly(path.join(userData, 'claude-api-key.json'));
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'mopilot-auth.json'), 'utf8')).enc).toBe('safe');
    expect(fs.existsSync(path.join(second, 'auth.json.enc'))).toBe(true);
    expectOwnerOnly(path.join(second, 'auth.json.enc'));

    // the key reads back from the encrypted file
    const claude = await page.evaluate(() => (window as any).native.claude.apiKey());
    expect(claude.hint).toBe('7777');
    // the added account signs the turn in from its encrypted sign-in
    await page.evaluate(() => (window as any).native.accounts.switchTo('second'));
    await expect.poll(async () => (await page.evaluate(() => (window as any).native.accounts.list())).active).toBe('second');
    await composer(page).fill('hello from the second account');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-codex: hello from the second account', { exact: true })).toBeVisible();
    const tokens = harness.codexLog().filter((l) => l.method === 'account/login/start' && l.params?.type === 'chatgptAuthTokens');
    expect(tokens.some((l) => l.params.chatgptAccountId === 'acct-second')).toBe(true);

    await harness.quit();
    expect(fs.existsSync(path.join(second, 'auth.json')), 'no plain sign-in once the app has quit').toBe(false);
    for (const secret of [CLAUDE_KEY, GATEWAY_KEY, 'fake-refresh']) expect(filesContaining(userData, secret), secret).toEqual([]);
    expect(filesContaining(userData, secondToken)).toEqual([]);
  });
});
