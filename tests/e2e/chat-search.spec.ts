// Cmd+K finds chats of every harness at once: Codex's thread/list(searchTerm) no longer replaces the
// Claude chats (D-25), and a Claude chat is found by what its transcript says, not only its title.
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'both' });

test('search-palette: one search lists the Codex and the Claude chat; a transcript-only match finds the Claude chat', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'zebra codex chat');
  await expect(transcript(page).getByText('fake-codex: zebra codex chat', { exact: true })).toBeVisible();

  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await send(page, 'zebra claude chat');
  await expect(transcript(page).getByText('fake-claude: zebra claude chat', { exact: true })).toBeVisible();

  await sidebar(page).getByRole('button', { name: 'Search' }).click();
  await page.getByPlaceholder('Search chats').fill('zebra');
  await expect.poll(() => harness.codexLog().some((e) => e.method === 'thread/list' && e.params.searchTerm === 'zebra')).toBe(true);
  // both chats, though Codex answered its own search with only its chat
  await expect(page.locator('.palette-item')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // only the reply carries this text; the title and first prompt do not
  await sidebar(page).getByRole('button', { name: 'Search' }).click();
  await page.getByPlaceholder('Search chats').fill('fake-claude: zebra');
  await expect(page.locator('.palette-item')).toHaveCount(1);
  await page.locator('.palette-item').first().click();
  await expect(transcript(page).getByText('fake-claude: zebra claude chat', { exact: true })).toBeVisible();
});
