// Main's startup on a long-time user's profile (fixtures/heavyProfile.ts, transcripts at a quarter of their sizes): only
// the sidebar rows on screen read their chats' histories (the PR badge), so main reads a few transcripts whole rather
// than every one, and its V8 heap stays within a budget. Every row reading at launch took main to gigabytes.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { heavyProfile } from './fixtures/heavyProfile';

const STARTUP_READS = path.join(__dirname, 'fixtures', 'startup-reads.cjs');
const profile = heavyProfile(0.25);
/** More rows than a 1010-pixel-tall window shows, a fraction of the profile's 331 Claude transcripts. */
const MAX_TRANSCRIPTS_READ = 60;
/** Main's V8 heap peak in the first minute: 186 MB when every row read its history, 122 MB with only on-screen rows, one at a time (GitHub macOS runners, 2026-10-30). */
const HEAP_BUDGET = 160 * 1024 * 1024;

test.use({ harnesses: 'both', seed: profile.seed, mainRequire: [STARTUP_READS] });
// writing the profile's transcripts happens in the fixture, before the test body
test.describe.configure({ timeout: 6 * 60_000 });

test('main reads only the on-screen rows’ transcripts at startup and keeps its heap within budget', async ({ page, harness }) => {
  await expect(page.getByRole('complementary')).toBeVisible({ timeout: 120_000 });
  // the sidebar fills and every on-screen row's badge settles well within a minute
  await page.waitForTimeout(60_000);
  const { transcripts, peak } = await harness.app.evaluate(() => {
    const reads = (globalThis as any).__startupReads;
    return { transcripts: reads.transcripts().length as number, peak: reads.peakHeap() as number };
  });
  test
    .info()
    .annotations.push({ type: 'startup', description: `transcripts read: ${transcripts}; heap peak: ${Math.round(peak / 1048576)} MB` });
  expect(transcripts, 'transcripts main read whole at startup').toBeLessThanOrEqual(MAX_TRANSCRIPTS_READ);
  expect(peak, "main's V8 heap peak in the first minute").toBeLessThan(HEAP_BUDGET);
});
