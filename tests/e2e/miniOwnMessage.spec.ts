// A message sent from Quick Chat shows in Quick Chat's own view, on Claude Code, whose turnStarting main sends only to the
// window the message came from (#2316): the first message and a follow-up appear as the user's own bubbles.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { chooseNewChatsDefault } from './fixtures/harnessPicker';

test.use({ harnesses: 'both' });

test('Mini on Claude Code: the sent message and a follow-up show in Quick Chat itself', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // Quick Chat starts on the saved default, set in Settings
  await chooseNewChatsDefault(page, 'Claude Code · Fake Sonnet');
  await page.evaluate(() => (window as any).native.win.mini());
  await expect.poll(() => harness.app.windows().some((w) => w.url().endsWith('#mini'))).toBe(true);
  const mini: Page = harness.app.windows().find((w) => w.url().endsWith('#mini'))!;
  const transcript = mini.getByRole('region', { name: 'Conversation transcript' });
  const box = mini.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('first from quick chat');
  await box.press('Enter');
  await expect(transcript.getByText('first from quick chat', { exact: true })).toBeVisible();
  await expect(transcript.getByText('fake-claude: first from quick chat', { exact: true })).toBeVisible();
  await box.fill('follow-up from quick chat');
  await box.press('Enter');
  await expect(transcript.getByText('follow-up from quick chat', { exact: true })).toBeVisible();
  await expect(transcript.getByText('fake-claude: follow-up from quick chat', { exact: true })).toBeVisible();
});
