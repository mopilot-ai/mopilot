// Original merged-PR footer repro on every harness: inline PR prose plus one compact rail, through repeat/live/completed states.
// Covers 'src/components/thread/PrInboxRail.tsx', 'src/components/thread/PrCount.tsx' and 'src/components/thread/ThreadView.tsx'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';
import { captureExternal } from './fixtures/externalUrls';
import { shootBoth, SYSTEM_THEME } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'ACP admission needs sage-mcp on macOS; all three harnesses use the same runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inbox-rail-'));
const snapshot = path.join(tmp, 'pr.json');
fs.writeFileSync(snapshot, JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-17T12:00:00Z' }));
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'), { FAKE_GH_STATE_FILE: snapshot });
test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const family of ['codex', 'claude', 'acp'] as const) {
  test.describe(`${family} merged PR rail`, () => {
    test.use({
      harnesses: family === 'acp' ? 'none' : family,
      acp: family === 'acp' ? { kimi: {} } : {},
      shellPath: [BIN],
      env: { PATH: withPath([BIN]) },
      seed: { uiState: { summaryOpen: true, prefs: { ...SYSTEM_THEME.prefs, fontSize: 24, zoomLevel: 0 } } },
    });

    test('a merged reply has a named PR row, never a duplicate activity footer', async ({ page, harness }) => {
      test.setTimeout(120_000);
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const send = async (text: string) => {
        await composer.fill(text);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
      };
      await send(`Opened [PR #7](${PR_URL}).`);
      const rail = page.getByRole('region', { name: 'Chat pull requests', exact: true });
      const pr = rail.getByRole('button', { name: 'Open pull request #7: Fix the parser', exact: true });
      // useListed refreshes once a minute; a new native chat's first read can precede its first reply.
      await expect(pr).toBeVisible({ timeout: 75_000 });
      await expect(page.locator('.assistant-message .md-pr-chip').first()).toBeVisible();
      await expect(pr.locator('[data-state="merged"] svg')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(page.locator('.tasks-count').filter({ hasText: /merged PR/ })).toHaveCount(0);

      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 682 });
        await pr.scrollIntoViewIfNeeded();
        const fit = await pr.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const icon = el.querySelector('svg')!.getBoundingClientRect();
          const number = el.querySelector('span:nth-child(2)')!.getBoundingClientRect();
          return {
            overflow: el.scrollWidth - el.clientWidth,
            left: bounds.left,
            right: bounds.right,
            width: innerWidth,
            iconBottom: icon.bottom,
            numberBottom: number.bottom,
          };
        });
        expect(fit.overflow).toBeLessThanOrEqual(1);
        expect(fit.left).toBeGreaterThanOrEqual(0);
        expect(fit.right).toBeLessThanOrEqual(fit.width);
        expect(Math.abs(fit.iconBottom - fit.numberBottom)).toBeLessThan(8);
        await shootBoth(page, harness.app, `merged-rail-${family}-${width}`);
      }
      const external = await captureExternal(harness);
      await pr.click();
      await expect.poll(external).toContain(PR_URL);

      // A later report names the same PR: the chat still has one row, while both prose replies retain their chips.
      await send(`Opened [PR #7](${PR_URL}) again.`);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(rail.getByRole('button', { name: /^Open pull request #/ })).toHaveCount(1);
      await expect(page.locator('.assistant-message .md-pr-chip')).toHaveCount(2);

      await send('SLOW HOLDREPLY check the merged footer');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await pr.scrollIntoViewIfNeeded();
      await expect(pr).toBeVisible();
      await expect(page.locator('.turn-status-slot').getByRole('button', { name: /^Pull requests:/ })).toHaveCount(0);
      await rail.getByRole('button', { name: 'Pull requests: 1 merged', exact: true }).click();
      const tray = page.getByRole('dialog', { name: 'Pull requests', exact: true });
      await expect(tray).toBeVisible();
      await expect(tray.getByRole('button', { name: 'Fix the parser', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(pr).toBeAttached();
    });
  });
}
