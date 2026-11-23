// Remote kill switches in the real app (WP0-6): a switch flipped through the local override or a fresh
// server cache changes what the picker lists, what a chat may start, and what tools the CLI is given.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** A flags cache the server wrote for this build, with these switches off. */
const cache = (...off: string[]) => ({
  fetchedAt: Date.now(),
  channel: 'stable',
  version: VERSION,
  flags: Object.fromEntries(off.map((k) => [k, false])),
});
const seedCache = (...off: string[]) => ({
  files: ({ userData }: { userData: string }) => fs.writeFileSync(path.join(userData, 'flags.json'), JSON.stringify(cache(...off))),
});

test.describe('local override: harness.codex.enabled off', () => {
  test.use({ harnesses: 'both', env: { MOPILOT_FLAGS: 'harness.codex.enabled=0' } });

  test('the picker lists only Claude Code and a new chat starts there', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    expect(await page.evaluate(() => (window as any).native.flags.isEnabled('harness.codex.enabled'))).toBe(false);
    // the default harness is Codex, which is off: the chat starts on Claude Code
    await expect(modelButton(page)).not.toContainText('Fake Model One');
    await modelButton(page).click();
    await page.getByRole('button', { name: 'Select harness and model' }).click();
    await expect(page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' })).toBeVisible();
    await expect(page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' })).toHaveCount(0);
  });
});

test.describe('server cache: harness.claude.enabled off', () => {
  test.use({
    harnesses: 'both',
    seed: {
      ...seedCache('harness.claude.enabled'),
      claudeSessions: [{ id: '5e3d9a8c-1b2f-4c6d-9e7a-0f1e2d3c4b5a', cwd: 'old-project', title: 'Old chat', turns: ['an old message'] }],
    },
  });

  test('a Claude chat refuses a new turn with the reason and the CLI never gets the message', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    expect(await page.evaluate(() => (window as any).native.flags.isEnabled('harness.claude.enabled'))).toBe(false);
    // the chat is listed under its folder and again in Recents
    await page.getByRole('complementary').getByText('Old chat').first().click();
    await expect(transcript(page).getByText('fake-claude: an old message')).toBeVisible();
    await send(page, 'one more thing');
    await expect(page.getByText('Turned off by MoPilot for now').first()).toBeVisible();
    // the message waits in the queue, like after a crash
    await expect(
      page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: 'one more thing' }),
    ).toBeVisible();
    expect(harness.claudeLog().some((e) => e.kind === 'in' && JSON.stringify(e.msg).includes('one more thing'))).toBe(false);
  });
});

test.describe('server cache: channel.claude.sdkMcp off', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: seedCache('channel.claude.sdkMcp') });

  test('the CLI is given no MoPilot tools: a computer call finds none, no card, nothing reaches the helper', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_click {"x":1,"y":2}');
    // the reply carries no [cu: ...]: the session has no MoPilot server at all, not even an empty one
    await expect(transcript(page).getByText(/^fake-claude: CUCALL computer_click/)).toBeVisible();
    await expect(page.locator('.sage-approval')).toHaveCount(0);
    expect(harness.claudeLog().some((e: any) => e.kind === 'cu')).toBe(false);
    expect(harness.helper!.log).toEqual([]);
  });
});
