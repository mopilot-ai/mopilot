// A sidebar PR badge's replies are saved in main across launches (electron/app/ipc/pullRequestReplies.cjs): on a long-time
// user's profile (fixtures/heavyProfile.ts, small transcripts) the first launch reads the on-screen rows' histories for
// their badges, and a second launch of the unchanged profile reads none.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { heavyProfile } from './fixtures/heavyProfile';

const HISTORY_READS = path.join(__dirname, 'fixtures', 'history-reads.cjs');
const profile = heavyProfile(0.02);

test.use({ harnesses: 'both', seed: profile.seed, mainRequire: [HISTORY_READS] });
test.describe.configure({ timeout: 6 * 60_000 });

/** The chats the badges asked main to read, once the sidebar filled and its on-screen rows settled. */
async function badgeReads(page: Page, harness: Harness): Promise<string[]> {
  await expect(page.getByRole('complementary')).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(45_000);
  return harness.app.evaluate(() => (globalThis as any).__historyReads());
}

test('a second launch of an unchanged profile reads no chat history for the sidebar badges', async ({ page, harness }) => {
  const first = await badgeReads(page, harness);
  expect(first.length, 'the first launch reads the on-screen rows').toBeGreaterThan(0);
  // a quit writes what the badges saved
  await harness.quit();
  await harness.relaunch();
  const second = await badgeReads(harness.page, harness);
  test
    .info()
    .annotations.push({ type: 'badge history reads', description: `first launch: ${first.length}; second launch: ${second.length}` });
  expect(second, 'chats the second launch read again').toEqual([]);
});
