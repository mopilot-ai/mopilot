import { test, expect } from './fixtures/app';
import { childMessagesParent, claudeProject, holdOnSwitch, messages, backToParent, startStandbyChild } from './fixtures/linkedFamily';

test.use({ harnesses: 'both' });

test('a queued message from a session the chat started shows who sent it, and its removal is recorded', async ({
  page,
  harness,
}, testInfo) => {
  // the parent runs a long turn and its harness switch is pending (it cannot take a steer), then its child messages it
  await claudeProject(page, harness, 'queue-project');
  await startStandbyChild(page, harness, 'Queue worker');
  await holdOnSwitch(page);
  await childMessagesParent(page, 'Blocked on the schema');
  await expect.poll(() => messages(harness).length, { timeout: 60_000 }).toBe(1);
  await backToParent(page);

  // the parent is busy: the message waits in its tray under the sender's name, not as the envelope
  const row = page.locator('.queue-row').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  // by the sender's chat title (the fake titles every chat "Fake chat title"), never as "another session"
  await expect(row.locator('.queue-text')).toHaveText('Received message from Fake chat title');
  await expect(page.locator('.queue-tray')).not.toContainText('mopilot-side-session-message');
  // Steer and Remove stay; the preview reads only the message
  await expect(row.getByRole('button', { name: 'Steer' })).toBeVisible();
  await row.locator('.queue-text').click();
  await expect(page.locator('.queue-preview-body')).toHaveText('Blocked on the schema');
  await page.screenshot({ path: testInfo.outputPath('queued-side-message-preview.png') });
  await page.getByRole('button', { name: 'Close preview' }).click();
  await row.getByRole('button', { name: 'Queued message actions' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Copy']);
  await page.keyboard.press('Escape');

  // removing it before it ran is recorded as removed, once
  expect(messages(harness)[0].removedAt).toBeUndefined();
  await row.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(page.locator('.queue-row')).toHaveCount(0);
  await expect.poll(() => typeof messages(harness)[0].removedAt, { timeout: 15_000 }).toBe('number');
  await page.screenshot({ path: testInfo.outputPath('queued-side-message-removed.png') });
});
