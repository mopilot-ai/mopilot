// The Mini bar (Quick Chat) and the tray's New Chat start from the default harness (WP7-19, A17): the
// bar's model picker shows the default harness and model, and a prompt sent from the bar becomes a new
// chat on that harness. (Quick Chat replaced the "harness · account" title with this picker in ffeaf855.)
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { chooseNewChatsDefault } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });

test.use({ harnesses: 'both' });

async function openMini(app: import('@playwright/test').ElectronApplication, page: Page) {
  await page.evaluate(() => (window as any).native.win.mini());
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('#mini'))).toBe(true);
  return app.windows().find((w) => w.url().endsWith('#mini'))!;
}

test('Mini: the picker shows the default harness; the prompt starts a chat on it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  // the default is Codex
  const mini = await openMini(harness.app, page);
  await expect(mini.locator('.quick-chat-title')).toHaveText('Quick Chat');
  const picker = mini.getByRole('button', { name: 'Select model' });
  await expect(picker.getByRole('img', { name: 'Codex' })).toBeVisible();
  await expect(picker).toContainText('Fake Model One');
  await expect(mini.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('placeholder', 'Ask anything');
  await mini.keyboard.press('Escape');

  // the default moves to Claude Code (Settings → New chats use); the bar follows it
  await chooseNewChatsDefault(page, 'Claude Code · Fake Sonnet');
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake Sonnet');
  const again = await openMini(harness.app, page);
  const picker2 = again.getByRole('button', { name: 'Select model' });
  await expect(picker2.getByRole('img', { name: 'Claude Code' })).toBeVisible();
  await expect(picker2).toContainText('Fake Sonnet');
  await again.getByRole('textbox', { name: 'Message', exact: true }).fill('from the mini bar');
  await again.keyboard.press('Enter');
  // Quick Chat shows the new chat in place; main runs it on Claude Code
  await expect(again.getByText('fake-claude: from the mini bar', { exact: true })).toBeVisible();
  expect(harness.claudeLog().some((e) => e.kind === 'in' && JSON.stringify(e.msg).includes('from the mini bar'))).toBe(true);
  // Open in app shows the same chat in the main window
  await again.getByRole('button', { name: 'Open in app' }).click();
  await expect(page.getByRole('main').getByText('fake-claude: from the mini bar', { exact: true })).toBeVisible();
  expect(harness.codexLog().filter((e) => e.method === 'turn/start')).toHaveLength(0);
});
