// The composer's permissions menu and model picker on both first-class harnesses (WP7-10, D-27, A17):
// anchors with the native name and the one-line difference, a Read-only row, and the model picker's
// model changes automatically becoming the new-chat default.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const permButton = (page: Page) => page.getByRole('button', { name: 'Change permissions' });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await modelButton(page).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'both' });

test('permissions menu: Codex rows carry the anchor, the native name and the difference; Read-only is selectable', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await permButton(page).click();
  const menu = page.locator('.perm-menu');
  await expect(menu).toContainText('What Codex can do');
  await expect(menu.locator('.perm-item')).toHaveCount(4);
  await expect(menu.locator('.perm-item.read-only')).toContainText('read-only sandbox');
  await expect(menu.locator('.perm-item.full-access')).toContainText('danger-full-access');
  await menu.locator('.perm-item.read-only').click();
  // the button no longer shows Ask for approval for a read-only chat
  await expect(permButton(page)).toContainText('Read-only');
  await permButton(page).click();
  await page.locator('.perm-menu .perm-item.default').click();
  await expect(permButton(page)).toContainText('Ask for approval');
});

test('permissions menu and model picker on a Claude chat; model defaults', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-claude: hello', { exact: true })).toBeVisible();

  await permButton(page).click();
  const menu = page.locator('.perm-menu');
  await expect(menu).toContainText('What Claude Code can do');
  await expect(menu.locator('.perm-item.read-only')).toContainText('writes and Bash are refused');
  await expect(menu.locator('.perm-item.default')).toContainText('default');
  await page.keyboard.press('Escape');

  // Model changes automatically become defaults, with no separate scope action.
  await modelButton(page).click();
  await expect(page.locator('.effort-model')).toContainText('Claude Code');
  await expect(page.locator('.effort-model')).toContainText('Fake Sonnet');
  await expect(page.getByRole('button', { name: 'Make default for new chats' })).toHaveCount(0);
});
