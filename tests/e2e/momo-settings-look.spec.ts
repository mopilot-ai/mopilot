// MoMo's Settings fields as they look (#2504), on fake harnesses only, for an invited account (MOPILOT_MOMO_DEV=1), in light and
// dark: the Memory tab's two documents have a visible border, and the quiet-hours times show its whole
// value ("07:23 PM", never "07:23 P"); screenshots of both are saved.
import { test, expect } from './fixtures/app';
import { goToMomoView, openMomo } from './fixtures/momo';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

for (const theme of ['light', 'dark'] as const) {
  test.describe(`MoMo's fields in ${theme}`, () => {
    test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: { uiState: { prefs: { theme } } } });

    test('the Memory documents have a visible edge and the quiet-hours times show their whole value', async ({ page }) => {
      await openMomo(page);

      // Memory: the two documents draw a border
      await goToMomoView(page, 'Memory');
      for (const name of ['About you', "MoMo's persona"]) {
        const doc = page.getByRole('textbox', { name, exact: true });
        await expect(doc).toBeVisible();
        const edge = await doc.evaluate((el) => {
          const s = getComputedStyle(el);
          return { width: Number.parseFloat(s.borderTopWidth), color: s.borderTopColor };
        });
        expect(edge.width, `${name} border width`).toBeGreaterThan(0);
        expect(edge.color, `${name} border colour`).not.toMatch(/rgba\(\d+, \d+, \d+, 0\)|transparent/);
      }
      await page.screenshot({ path: test.info().outputPath(`memory-${theme}-docs.png`) });

      // Settings › MoMo › Brain › Proactivity: the quiet-hours times keep their day period
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
      await page.getByRole('button', { name: 'MoMo', exact: true }).click();
      const start = page.getByLabel('Quiet hours start');
      await start.scrollIntoViewIfNeeded();
      await start.fill('19:23');
      await start.blur();
      for (const field of await page.locator('input.momo-time').all()) {
        const clipped = await field.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(clipped, 'a time field cuts its value off').toBe(false);
      }
      await page.screenshot({ path: test.info().outputPath(`settings-${theme}-time.png`) });
    });
  });
}
