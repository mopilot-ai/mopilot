// CUJ multi-account-relay, the part account-switching.spec.ts (Claude Code's limit hand-over) and accounts.spec.ts
// (listing and Use) leave open: a Codex turn that hits a usage limit moves the chat to the second ChatGPT account and
// carries on with a note in the chat; and on both harnesses an expired login on the account in use shows a sign-in
// action, which signs it in again so the next message runs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';
import { twoCodexAccounts } from './fixtures/codexAccounts';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('Codex: a usage limit mid-turn', () => {
  test.use({ seed: { files: (d) => twoCodexAccounts(d) } });

  test('the chat moves to the second ChatGPT account and carries on, with the note', async ({ page, harness }) => {
    // the CLI's own login (first@) is out of usage: this turn ends on usageLimitExceeded
    await send(page, 'USAGELIMIT build the report');
    await expect(transcript(page).getByText(/^Usage limit reached(?: on \S+)?\. Continued on second@example\.test$/)).toBeVisible();
    // main continued the chat by itself, on the other account, once the controller had ended the turn that ran out (it
    // reads the turn's changes first, which can take seconds on a cold runner, #1728)
    const sent = () =>
      harness
        .codexLog()
        .filter((l) => l.method === 'turn/start')
        .map((l) => JSON.stringify(l.params?.input ?? null));
    await expect
      .poll(() => sent().some((t) => t.includes('Continue where you left off.')), {
        timeout: 20_000,
        message: 'main sends "Continue where you left off." to Codex',
      })
      .toBe(true);
    await expect(transcript(page).getByText('fake-codex: Continue where you left off.', { exact: true })).toBeVisible();
    const view = await page.evaluate(() => (window as any).native.accounts.list());
    expect(Object.values(view.chatAccounts).map((c: any) => c.id)).toContain('second');
    // the next message in the chat runs as usual
    await send(page, 'and the summary');
    await expect(transcript(page).getByText('fake-codex: and the summary', { exact: true })).toBeVisible();
  });
});

test.describe('Codex: an expired login', () => {
  test.use({
    // the second account lapsed earlier, so there is nowhere to move: the user has to sign in again
    seed: {
      files: (d) => {
        twoCodexAccounts(d, 'expired');
        fs.writeFileSync(path.join(d.codexHome, '.fake-expired'), '');
      },
    },
    // signing in again comes back as the same account
    env: { FAKE_CODEX_LOGIN_EMAIL: 'first@example.test', FAKE_CODEX_LOGIN_ACCOUNT: 'acct-first' },
  });

  test('shows Sign in again, and signing in lets the next message run', async ({ page, harness }) => {
    const opened = await captureExternal(harness);
    // the app-server's token refresh fails: the turn ends, and the account in use says it needs a sign-in
    await send(page, 'AUTHEXPIRED hello');
    const banner = page.locator('.acct-banner', { hasText: 'has expired' });
    await expect(banner).toContainText('Your Codex sign-in for first@example.test has expired.');
    await banner.getByRole('button', { name: 'Sign in again' }).click();
    await expect.poll(opened).toContain('https://auth.example.test/codex');
    await expect(page.getByText('Signed in again as first@example.test')).toBeVisible();
    await expect(banner).toHaveCount(0);
    await send(page, 'hello again');
    await expect(transcript(page).getByText('fake-codex: hello again', { exact: true })).toBeVisible();
  });
});

test.describe('Claude Code: an expired login', () => {
  // the CLI still says "logged in", but its token lapsed: every turn ends on authentication_failed
  // with Codex there too, a lapsed Claude login leaves something usable, so the chat stays on screen with a banner (with
  // nothing usable the welcome flow takes the screen instead, cuj-sign-in-auth.spec.ts)
  test.use({ harnesses: 'both', seed: { files: (d) => fs.writeFileSync(path.join(d.claudeHome, '.fake-expired'), '') } });

  test('shows Sign in, and signing in lets the next message run', async ({ page }) => {
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await send(page, 'hello there');
    const banner = page.locator('.acct-banner', { hasText: 'has expired' });
    await expect(banner).toContainText('Your Claude Code sign-in');
    await expect(transcript(page).getByText('fake-claude: hello there', { exact: true })).toHaveCount(0);
    // `claude auth login` runs in the embedded terminal; when it exits the app checks again
    await banner.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(banner).toHaveCount(0, { timeout: 20_000 });
    await send(page, 'hello again');
    await expect(transcript(page).getByText('fake-claude: hello again', { exact: true })).toBeVisible();
  });
});
