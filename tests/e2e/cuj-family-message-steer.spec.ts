// A session messages its parent while the parent's turn is running: the message steers into that turn at once (no queue
// row, the sender's receipt is "delivered"), as Claude Desktop 4.29.0 does (#3255). The queued fallbacks (ACP, a turn
// awaiting the user, a pending switch) are in cuj-queued-side-message*.spec.ts and the unit tests.
import { test, expect } from './fixtures/app';
import {
  backToParent,
  childMessagesParent,
  claudeProject,
  messages,
  runSlow,
  startStandbyChild,
  transcript,
} from './fixtures/linkedFamily';

test.use({ harnesses: 'both' });

test('a message to a parent that is running a turn steers into it: no queue row, and the sender is told it was delivered', async ({
  page,
  harness,
}, testInfo) => {
  await claudeProject(page, harness, 'steer-project');
  await startStandbyChild(page, harness, 'Steer worker');

  // the parent's turn keeps running (SLOW waits for an interrupt): the child's message goes into it
  await runSlow(page);
  await childMessagesParent(page, 'Steer this in');
  await expect.poll(() => messages(harness).length, { timeout: 60_000 }).toBe(1);
  await expect(
    transcript(page)
      .getByText(/"status": ?"delivered"/)
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await backToParent(page);
  await expect(page.locator('.side-session-card[data-kind="message"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.queue-row')).toHaveCount(0);
  expect(messages(harness)[0].removedAt).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('family-message-steered.png') });
});
