import { test, expect } from './fixtures/app';
import {
  childMessagesParent,
  claudeProject,
  composer,
  holdOnSwitch,
  messages,
  backToParent,
  startStandbyChild,
} from './fixtures/linkedFamily';

test.use({ harnesses: 'both' });

test('switching the harness leaves a queued message from another session queued, never in the composer', async ({
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

  // the parent is busy: the message waits in its tray
  const row = page.locator('.queue-row').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('.queue-text')).toHaveText('Received message from Fake chat title');

  // it is not the user's text: the composer stays empty, the row stays queued, and its sender is not told it was removed
  await expect(composer(page)).toHaveText('');
  await expect(page.locator('.queue-tray')).not.toContainText('mopilot-side-session-message');
  await expect(row.locator('.queue-text')).toHaveText('Received message from Fake chat title');
  expect(messages(harness)[0].removedAt).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('queued-side-message-after-switch.png') });
});
