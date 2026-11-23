// CUJ errors-limits-offline on Codex and Claude Code: the provider fails mid-turn while the harness retries (after a
// finished step), the usage limit is hit with no second login to move to, and the login expires. The chat says what
// happened without restarting a recovering turn; the composer can stop it. Terminal errors retain their recovery.
// The retrying provider and LOGINEXPIRED are fixtures/fake-codex-trouble.mjs and
// fake-claude-trouble.mjs; the usage limits are fake-codex-accounts.mjs (USAGELIMIT) and fake-claude-limits.mjs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness, type Dirs } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const banner = (page: Page) => page.locator('.turn-stall');
const turnError = (page: Page) => transcript(page).locator('.turn-error');
const TITLE = /as a short chat title/;

async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const codexSent = (h: Harness) =>
  h
    .codexLog()
    .filter((e) => e.method === 'turn/start')
    .map((e) => e.params.input?.[0]?.text ?? '')
    .filter((t) => !TITLE.test(t));
const claudeSent = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
    .map((e: any) => {
      const c = e.msg.message?.content;
      return typeof c === 'string' ? c : (c ?? []).map((b: any) => b.text ?? '').join('');
    })
    .filter((t) => !TITLE.test(t) && t.trim() !== '/usage');

test.describe('Codex', () => {
  test('errors-limits-offline on Codex: provider recovery is informational; only an explicit new message sends again', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'PROVIDERRETRY run the tests');
    await expect(banner(page)).toContainText('Reconnecting...');
    await expect(banner(page).getByRole('button')).toHaveCount(0);
    expect(codexSent(harness)).toEqual(['PROVIDERRETRY run the tests']);
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0);
    await send(page, 'PROVIDERRETRY run the tests');
    await expect(transcript(page).getByText('fake-codex: PROVIDERRETRY run the tests [lint already ran]', { exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(stop(page)).toHaveCount(0);
    const log = harness.codexLog();
    expect(log.filter((e) => e.method === 'turn/interrupt')).toHaveLength(1);
    expect(codexSent(harness)).toEqual(['PROVIDERRETRY run the tests', 'PROVIDERRETRY run the tests']);
    expect(log.filter((e) => e.method === 'fake/command')).toHaveLength(1);
  });

  test('errors-limits-offline on Codex: the usage limit with no other account says so and sends nothing again', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'USAGELIMIT big refactor');
    await expect(turnError(page)).toContainText("You've hit your usage limit");
    await expect(stop(page)).toHaveCount(0);
    // no account to move to: nothing continues the chat by itself
    await page.waitForTimeout(3000);
    expect(codexSent(harness)).toEqual(['USAGELIMIT big refactor']);
    await expect(composer(page)).toBeEnabled();
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude' });

  test('errors-limits-offline on Claude Code: API recovery is informational; only an explicit new message sends again', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'PROVIDERRETRY read the readme');
    await expect(banner(page)).toContainText("Claude's API returned 529 overloaded_error. Claude Code keeps retrying");
    await expect(banner(page).getByRole('button')).toHaveCount(0);
    expect(claudeSent(harness)).toEqual(['PROVIDERRETRY read the readme']);
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0);
    await send(page, 'PROVIDERRETRY read the readme');
    await expect(
      transcript(page).getByText('fake-claude: PROVIDERRETRY read the readme [read already done]', { exact: true }),
    ).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(stop(page)).toHaveCount(0);
    const log = harness.claudeLog();
    expect(log.filter((e: any) => e.kind === 'in' && e.msg?.request?.subtype === 'interrupt')).toHaveLength(1);
    expect(claudeSent(harness)).toEqual(['PROVIDERRETRY read the readme', 'PROVIDERRETRY read the readme']);
    expect(log.filter((e: any) => e.kind === 'tool' && e.name === 'Read')).toHaveLength(1);
  });
});

test.describe('Claude Code with its only login out of usage', () => {
  test.use({ harnesses: 'claude', seed: { files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '') } });

  test('errors-limits-offline on Claude Code: the usage limit with no second login says so and sends nothing again', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'big refactor');
    await expect(transcript(page).getByText('Claude AI usage limit reached', { exact: true })).toBeVisible();
    await expect(transcript(page).locator('.status-note.limit')).toHaveCount(1);
    await expect(transcript(page).getByText(/Continued on/)).toHaveCount(0);
    await expect(stop(page)).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(claudeSent(harness)).toEqual(['big refactor']);
    await expect(composer(page)).toBeEnabled();
  });
});

// With switching enabled and Codex signed in, main carries the limited chat on even when reset continuation is off.
// The turn continues on Codex once (electron/session/limitContinue.cjs).
test.describe('Claude Code out of usage, with Codex signed in', () => {
  test.use({
    harnesses: 'both',
    seed: {
      uiState: { prefs: { autoContinueOnLimit: false, autoSwitchHarnessOnLimit: true } },
      files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), ''),
    },
  });

  test('errors-limits-offline on Claude Code: an opted-in chat switches harness once with reset continuation off', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await pickModel(page, 'Claude Code', 'Fake Sonnet');
    await send(page, 'big refactor');
    await expect(transcript(page).getByText('Claude AI usage limit reached', { exact: true })).toBeVisible();
    await expect.poll(() => codexSent(harness).filter((t) => t.includes('Continue')), { timeout: 20_000 }).toHaveLength(1);
    await page.waitForTimeout(3000);
    expect(codexSent(harness).filter((t) => t.includes('Continue'))).toHaveLength(1);
    expect(claudeSent(harness)).toEqual(['big refactor']);
  });
});

// With only one harness signed in, a lapsed login leaves nothing that can run a chat and the app goes back to its
// first-run page; with the other harness still signed in, the chat stays and says what happened.
test.describe('an expired login, with the other harness signed in', () => {
  test.use({ harnesses: 'both' });

  test('errors-limits-offline on Codex: an expired login says so and sends nothing again', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'LOGINEXPIRED keep going');
    await expect(turnError(page)).toContainText('Please log out and sign in again.');
    await expect(stop(page)).toHaveCount(0);
    // #1745: no Sign in is offered for Codex's own lapsed login (Claude Code's turn has one, below)
    await page.waitForTimeout(1000);
    expect(codexSent(harness)).toEqual(['LOGINEXPIRED keep going']);
  });

  test('errors-limits-offline on Claude Code: an expired login says so and offers Sign in', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await pickModel(page, 'Claude Code', 'Fake Sonnet');
    await send(page, 'LOGINEXPIRED keep going');
    await expect(turnError(page)).toContainText('OAuth token has expired');
    await turnError(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
    expect(claudeSent(harness)).toEqual(['LOGINEXPIRED keep going']);
  });
});
