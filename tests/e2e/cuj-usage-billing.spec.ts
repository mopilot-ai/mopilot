// CUJ usage-billing on both harnesses: Settings → Accounts & billing shows each harness's plan limits (what is left of
// the 5-hour and weekly windows), the harness's "Pay with" row (under Advanced) switches between the subscription and an
// API key (kept when switching back), and the key can be added with another provider's URL and removed again. What the app does
// with each choice is read from what the fakes started with.
import { standaloneNewChat } from './fixtures/sidebar';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
/** A ChatGPT login in the Codex home, as `codex login` leaves it. */
function chatgptLogin(d: Dirs) {
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-first', chatgpt_plan_type: 'plus' } };
  const tokens = {
    access_token: jwt({ ...auth, exp: 4e9 }),
    id_token: jwt({ ...auth, email: 'first@example.test' }),
    refresh_token: 'fake',
    account_id: 'acct-first',
  };
  fs.writeFileSync(path.join(d.codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
}

async function openAccounts(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Accounts & billing' }).click();
  // Pay with and the run-out rule sit under each provider's Advanced fold, closed until opened
  const folds = page.locator('details.acct-advanced');
  await expect(folds).toHaveCount(2);
  for (const fold of await folds.all())
    if (!(await fold.evaluate((d) => (d as HTMLDetailsElement).open))) await fold.locator('summary').click();
}
const billing = (page: Page, harness: 'Codex' | 'Claude Code') => page.locator(`#billing-${harness === 'Codex' ? 'codex' : 'claude'}`);
const payRow = (page: Page, harness: 'Codex' | 'Claude Code') => billing(page, harness).locator('.settings-row', { hasText: 'Pay with' });
const claudeStarts = (h: Harness) =>
  h.claudeLog().filter((e) => e.kind === 'argv' && e.argv.some((a) => /^--(session-id|resume)=/.test(a))) as any[];

test.describe('Codex', () => {
  test.use({ harnesses: 'codex', env: { FAKE_CODEX_USAGE: '1' }, seed: { files: chatgptLogin } });

  test('usage-billing on Codex: plan limits, the API key form on the Pay with row', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await openAccounts(page);
    // plan limits: what is left of each window
    const row = page.locator('.acct-row', { hasText: 'first@example.test' });
    await expect(row).toBeVisible();
    await expect(row.locator('.acct-limit').nth(0)).toContainText('58% left');
    await expect(row.locator('.acct-limit').nth(1)).toContainText('90% left');

    // pay with an API key: choosing it with no key saved asks for one, another provider's URL behind a link; Cancel goes back.
    // (Saving is not walked: the app checks the key with OpenAI first, and the tests never reach the network.)
    const pay = payRow(page, 'Codex');
    await expect(pay.getByRole('button', { name: 'Subscription' })).toHaveClass(/on/);
    await pay.getByRole('button', { name: 'API key', exact: true }).click();
    await expect(pay.getByPlaceholder(/sk-/)).toBeVisible();
    await expect(pay.getByPlaceholder(/https:\/\//)).toHaveCount(0);
    await pay.getByRole('button', { name: 'Use another provider' }).click();
    await expect(pay.getByPlaceholder(/https:\/\//)).toBeVisible();
    await pay.getByRole('button', { name: 'Cancel' }).click();
    await expect(pay.getByRole('button', { name: 'Subscription' })).toHaveClass(/on/);
    await expect(pay.getByRole('button', { name: 'Add key' })).toBeVisible();
    expect(harness.codexLog().some((e) => e.method === 'account/login/start' && e.params.type === 'apiKey')).toBe(false);
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude' });

  test('usage-billing on Claude Code: plan limits, API key with an endpoint, back to the subscription, remove the key', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await openAccounts(page);
    // plan limits from the CLI's /usage: 12% of the session and 34% of the week used
    const limits = page.locator('.acct-limits').first();
    await expect(limits.locator('.acct-limit').nth(0)).toContainText('88% left');
    await expect(limits.locator('.acct-limit').nth(1)).toContainText('66% left');

    // pay with an API key and another provider's URL: new chats run on it
    const pay = payRow(page, 'Claude Code');
    await pay.getByRole('button', { name: 'API key', exact: true }).click();
    await pay.getByPlaceholder(/sk-ant/).fill('sk-ant-test-12345');
    await pay.getByRole('button', { name: 'Use another provider' }).click();
    await pay.getByPlaceholder(/https:\/\//).fill('https://gateway.example.test/anthropic');
    await pay.getByRole('button', { name: 'Save' }).click();
    await expect(pay.getByRole('button', { name: 'API key', exact: true })).toHaveClass(/on/);
    await expect(pay).toContainText('gateway.example.test');
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await composer(page).fill('on the api key');
    await expect(composer(page)).toHaveText('on the api key');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-claude: on the api key', { exact: true })).toBeVisible();
    expect(claudeStarts(harness).at(-1).billing).toEqual({ key: true, baseUrl: 'https://gateway.example.test/anthropic' });

    // back to the subscription: the key is kept; the next session runs on the login again
    await openAccounts(page);
    await pay.getByRole('button', { name: 'Subscription' }).click();
    await expect(pay.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await standaloneNewChat(page).click();
    await composer(page).fill('on the subscription');
    await expect(composer(page)).toHaveText('on the subscription');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-claude: on the subscription', { exact: true })).toBeVisible();
    expect(claudeStarts(harness).at(-1).billing).toEqual({ key: false, baseUrl: null });

    // remove the key
    await openAccounts(page);
    await pay.getByRole('button', { name: 'Remove key' }).click();
    await expect(pay.getByRole('button', { name: 'Add key' })).toBeVisible();
  });
});

// MoPilot credits (D-81): signed in to MoPilot, Claude Code's Pay with row offers them next to the other ways to
// pay. The model picker's billing switch and the signed-out row's "Use MoPilot credits" (with its confirm before
// leaving the subscription) were removed in #309, which keeps billing controls in Settings.
const signedInToMoPilot = {
  userData: {
    'mopilot-auth.json': {
      v: 1,
      enc: 'plain',
      data: Buffer.from(
        JSON.stringify({ refreshToken: 'r', gatewayKey: 'gw-test', user: { email: 'credits@example.test' }, deviceId: 'd' }),
      ).toString('base64'),
    },
  },
};
const authMode = (h: Harness) => {
  try {
    return fs.readFileSync(path.join(h.dir, 'userData', 'claude-auth-mode'), 'utf8').trim();
  } catch {
    return 'subscription';
  }
};
async function claudeRow(page: Page) {
  await openHarnessList(page);
  return page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
}

/** Claude Code's Pay with row switched to MoPilot credits (the picker's billing switch moved here in #309). */
async function payWithCredits(page: Page) {
  await openAccounts(page);
  const pay = payRow(page, 'Claude Code');
  await pay.getByRole('button', { name: 'MoPilot credits', exact: true }).click();
  return pay;
}

test.describe('MoPilot credits on the Pay with row, signed in', () => {
  test.use({ harnesses: 'claude', seed: signedInToMoPilot });

  test('usage-billing: Claude Code pays with MoPilot credits from Settings, and goes back to the subscription', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    // the picker's rows carry no billing controls since #309: they are on Settings → Accounts & billing
    const row = await claudeRow(page);
    await expect(row.getByRole('button', { name: /MoPilot credits|Switch to/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // signed in to MoPilot, Pay with offers the credits next to the subscription; no API key saved, so no key choice yet
    await openAccounts(page);
    const pay = payRow(page, 'Claude Code');
    await expect(pay.getByRole('button', { name: 'Subscription', exact: true })).toHaveClass(/on/);
    await expect(pay.getByRole('button', { name: 'Add key' })).toBeVisible();
    await pay.getByRole('button', { name: 'MoPilot credits', exact: true }).click();
    await expect.poll(() => authMode(harness)).toBe('mopilot');
    await expect(pay.getByRole('button', { name: 'MoPilot credits', exact: true })).toHaveClass(/on/);
    await expect(pay).toContainText('credits@example.test');
    await expect(pay.getByRole('button', { name: 'Buy credits' })).toBeVisible();

    // back to the subscription
    await pay.getByRole('button', { name: 'Subscription', exact: true }).click();
    await expect.poll(() => authMode(harness)).toBe('subscription');
    await expect(pay.getByRole('button', { name: 'Subscription', exact: true })).toHaveClass(/on/);
  });
});

// The gateway's capability table (GET /v1/models) names deepseek-flash, which the CLI does not list: on the MoPilot
// route the Claude Code model list offers it, and not before the credits are switched on.
const GATEWAY_PORT = 39817;
test.describe('MoPilot credits: the gateway models in the Claude Code list', () => {
  test.use({ harnesses: 'claude', seed: signedInToMoPilot, env: { MOPILOT_API: `http://127.0.0.1:${GATEWAY_PORT}` } });
  let gateway: http.Server;
  test.beforeAll(async () => {
    gateway = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/models')) {
        res.end(
          JSON.stringify({
            data: [
              { id: 'claude-opus-5-5', mopilot: { wires: ['anthropic'], efforts: ['low', 'high'], fast: true } },
              { id: 'deepseek-flash', mopilot: { wires: ['anthropic'], efforts: ['low', 'high', 'max'], fast: false } },
              { id: 'gpt-6-luna', mopilot: { wires: ['responses', 'chat'], fast: false } },
            ],
          }),
        );
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));
  });
  test.afterAll(() => new Promise<void>((r) => gateway.close(() => r())));

  test('usage-billing: deepseek-flash is a Claude Code model once MoPilot credits pay, and gpt models are not', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    let row = await claudeRow(page);
    await row.click();
    await expect(page.locator('.hp-models')).not.toContainText('deepseek-flash');
    await page.keyboard.press('Escape');
    await payWithCredits(page);
    await expect.poll(() => authMode(harness)).toBe('mopilot');
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(home(page)).toBeVisible();
    row = await claudeRow(page);
    await row.click();
    // a gateway model is the only way to pick its family, so it is a main model, not under "More versions" (#1197)
    await expect(page.locator('.hp-models')).not.toContainText('More versions');
    await expect(page.locator('.hp-models')).toContainText('deepseek-flash');
    await expect(page.locator('.hp-models')).not.toContainText('gpt-6-luna');
  });
});

test.describe('MoPilot credits on the Pay with row, signed out of Claude Code', () => {
  test.use({ harnesses: 'codex', seed: signedInToMoPilot });

  test('usage-billing: with Claude Code signed out, Pay with → MoPilot credits bills the credits and the picker row is usable', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    let row = await claudeRow(page);
    await expect(row).toContainText('Signed out');
    await page.keyboard.press('Escape');
    await payWithCredits(page);
    await expect.poll(() => authMode(harness)).toBe('mopilot');
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(home(page)).toBeVisible();
    // credits stand in for the login: the row is no longer signed out
    row = await claudeRow(page);
    await expect(row).not.toContainText('Signed out');
  });
});

test.describe('MoPilot credits on the Pay with row, not signed in to MoPilot', () => {
  test.use({ harnesses: 'codex' });

  test('usage-billing: choosing MoPilot credits starts the MoPilot sign-in first and changes nothing when it does not finish', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const opened = await captureExternal(harness);
    await payWithCredits(page);
    // the sign-in opens in the browser; credits are only used once it completes
    await expect.poll(async () => (await opened()).length).toBeGreaterThan(0);
    expect((await opened())[0]).toMatch(/^https?:\/\//);
    expect(authMode(harness)).toBe('subscription');
  });
});
