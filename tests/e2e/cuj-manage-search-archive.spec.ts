import { archiveSidebarChat, chooseSidebarChatAction } from './fixtures/sidebar';
// CUJ manage-search-archive on both harnesses: a chat is pinned, renamed, found by Cmd+K search, archived,
// found and restored in Settings → Archived chats, archived again and deleted for good (the harness is told).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}
async function openArchived(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Archived chats' }).click();
}

/** Everything the chat's list offers, from a chat's first message to deleting it. */
async function journey(page: Page, harness: Harness, reply: string, onDeleted: () => void | Promise<void>) {
  await send(page, 'a chat to look after');
  await expect(transcript(page).getByText(`${reply}: a chat to look after`, { exact: true })).toBeVisible();
  const row = sidebar(page).locator('.thread-row', { hasText: 'Fake chat title' });
  await expect(row).toBeVisible();

  // pin: the chat is listed under Pinned
  await row.hover();
  await chooseSidebarChatAction(page, row, 'Pin');
  await expect(sidebar(page).locator('.side-label', { hasText: 'Pinned' })).toBeVisible();
  // it is listed twice now, under Pinned and in Recents, and offers Unpin
  await expect(sidebar(page).locator('.thread-row', { hasText: 'Fake chat title' })).toHaveCount(2);
  await sidebar(page).locator('.thread-row', { hasText: 'Fake chat title' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'More options' }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // rename, then find it with search
  await row.first().dblclick();
  const input = sidebar(page).getByRole('textbox');
  await input.fill('Weekly report notes');
  await input.press('Enter');
  const renamed = sidebar(page).locator('.thread-row', { hasText: 'Weekly report notes' });
  await expect(renamed.first()).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Search' }).click();
  await page.getByPlaceholder('Search chats').fill('weekly report');
  await expect(page.locator('.palette-title', { hasText: 'Weekly report notes' })).toBeVisible();
  await page.keyboard.press('Escape');

  // archive: it leaves the list; Settings → Archived chats has it, and Unarchive brings it back
  await renamed.first().hover();
  await archiveSidebarChat(page, renamed.first());
  await expect(renamed).toHaveCount(0);
  await openArchived(page);
  await page.getByPlaceholder('Search archived chats').fill('weekly');
  const archived = page.locator('.settings-row', { hasText: 'Weekly report notes' });
  await expect(archived).toBeVisible();
  await archived.getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByText('Chat restored')).toBeVisible();
  await expect(archived).toHaveCount(0);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await expect(sidebar(page).locator('.thread-row', { hasText: 'Weekly report notes' }).first()).toBeVisible();

  // archive again and delete it for good: the confirm dialog is accepted, the chat is gone from both lists
  page.on('dialog', (d) => d.accept());
  const again = sidebar(page).locator('.thread-row', { hasText: 'Weekly report notes' }).first();
  await again.hover();
  await archiveSidebarChat(page, again);
  await openArchived(page);
  const doomed = page.locator('.settings-row', { hasText: 'Weekly report notes' });
  await doomed.getByRole('button').nth(1).click();
  await expect(doomed).toHaveCount(0);
  await expect(page.getByText('No archived chats')).toBeVisible();
  await onDeleted();
}

test.use({ harnesses: 'both' });

test('manage-search-archive on Codex: pin, rename, search, archive, restore, delete', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await journey(page, harness, 'fake-codex', async () => {
    const methods = harness.codexLog().map((e) => e.method);
    expect(methods).toEqual(expect.arrayContaining(['thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete']));
  });
});

test('manage-search-archive on Claude Code: pin, rename, search, archive, restore, delete', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await journey(page, harness, 'fake-claude', async () => {
    // deleting removes the session's transcript from the CLI's folder
    const projects = path.join(harness.dir, 'home', '.claude', 'projects');
    const left = fs.existsSync(projects)
      ? fs.readdirSync(projects).flatMap((d) => fs.readdirSync(path.join(projects, d)).filter((f) => f.endsWith('.jsonl')))
      : [];
    expect(left).toEqual([]);
  });
});
