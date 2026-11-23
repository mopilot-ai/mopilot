// A window's config change keeps what main saved for the chat meanwhile (#2520): an old Claude Code chat's first turn here
// saves its model and effort in main, which the window never wrote; picking a permission then must not drop them.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const SID = '7c1e4b2a-9d3f-4e5a-8b6c-1f2e3d4c5b6a';
const sidebar = (page: Page) => page.getByRole('complementary');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

test.use({
  harnesses: 'claude',
  seed: { claudeSessions: [{ id: SID, cwd: 'old-project', title: 'Old chat', turns: ['an old message'] }] },
});

test('a permission picked in the window keeps the model and effort main saved for the chat', async ({ page, harness }) => {
  // what main keeps for the chat, on disk (electron/platform/chats.cjs)
  const file = path.join(harness.env.MOPILOT_USER_DATA, 'threads', `${encodeURIComponent(`claude:${SID}`)}.v2`);
  const config = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).meta?.config ?? null;
    } catch {
      return null;
    }
  };
  await sidebar(page).getByText('Old chat', { exact: true }).first().click();
  await expect(transcript(page).getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await composer(page).fill('carry on');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: carry on', { exact: true })).toBeVisible();
  // main kept what the turn ran on (electron/session/keepSelection.cjs)
  await expect.poll(() => Object.keys(config() ?? {}).sort()).toEqual(expect.arrayContaining(['effort', 'model']));
  const kept = config();

  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.locator('.perm-menu .perm-item.read-only').click();
  await expect.poll(() => config()?.permission).toBe('read-only');
  expect(config()).toMatchObject({ model: kept.model, effort: kept.effort });
});
