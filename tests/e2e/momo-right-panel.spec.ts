// MoMo's right panel (the approved Dot-style page, designs/momo-page-dot), on fake Claude Code and fake Codex, in the app's light and dark themes: with room beside the chat column the panel shows MoMo's identity, "MoMo's computer", Devices with this Mac and Recent activity, the identity leaves the header, Pause and Resume change its status, Memory opens MoMo's Memory; the toggle hides it and is remembered through a reload; a window without room for it has no panel and keeps the identity in the header. A screenshot per theme is saved for review.
import { test, expect } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { momoSeed, openMomo } from './fixtures/momo';

for (const theme of ['light', 'dark'] as const) {
  for (const harnesses of ['claude', 'codex'] as const) {
    test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}, ${theme}`, () => {
      test.use({
        harnesses,
        // e2e launches turn on every flag in development (@dev): momo.outputs is pinned off for the no-Outputs assertion
        env: { MOPILOT_MOMO_DEV: '1', MOPILOT_FLAGS: 'momo.outputs=0' },
        seed: { ...momoSeed(harnesses).seed, uiState: { prefs: { theme } } },
      });

      test('the panel beside the chat: identity, computer, devices and activity; Pause; toggle remembered; none without room', async ({
        page,
        harness,
      }) => {
        test.setTimeout(150_000);
        await sizeViewport(page, harness, 1680, 900);
        await openMomo(page);
        const chat = page.getByRole('region', { name: 'Chat', exact: true });
        const panel = page.getByRole('region', { name: 'MoMo details' });
        await expect(panel).toBeVisible();
        const box = (await panel.boundingBox())!;
        expect(Math.round(box.width)).toBe(360);
        await expect(panel.getByText('MoMo’s computer')).toBeVisible();
        await expect(panel.getByText('This Mac', { exact: true }).first()).toBeVisible();
        await expect(panel.getByRole('heading', { name: 'Devices' })).toBeVisible();
        await expect(panel.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
        // MoMo Outputs is behind the momo.outputs flag, off by default: no section
        await expect(panel.getByRole('heading', { name: 'Outputs' })).toHaveCount(0);
        // the identity is the panel's now, not the header's
        await expect(panel.getByText('MoMo', { exact: true })).toBeVisible();
        await expect(chat.locator('header').getByText('MoMo', { exact: true })).toHaveCount(0);
        await expect(panel.getByText('Active', { exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`momo-panel-${harnesses}-${theme}.png`) });

        // Pause and Resume
        await panel.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(panel.getByText('Paused', { exact: true })).toBeVisible();
        await panel.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(panel.getByText('Active', { exact: true })).toBeVisible();

        // the toggle hides it, and the choice survives a reload
        await chat.getByRole('button', { name: 'Hide details' }).click();
        await expect(panel).toHaveCount(0);
        await expect(chat.locator('header').getByText('MoMo', { exact: true })).toBeVisible();
        await page.reload();
        await openMomo(page);
        await expect(page.getByRole('region', { name: 'MoMo details' })).toHaveCount(0);
        await chat.getByRole('button', { name: 'Show details' }).click();
        await expect(page.getByRole('region', { name: 'MoMo details' })).toBeVisible();

        // Memory from the panel
        await page.getByRole('region', { name: 'MoMo details' }).getByRole('button', { name: 'Memory', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
        await page.getByRole('complementary', { name: 'MoMo' }).getByRole('button', { name: 'Chat' }).click();

        // a window without room for the chat column and the panel: no panel, no toggle, the identity back in the header
        await sizeViewport(page, harness, 1280, 900);
        await expect(page.getByRole('region', { name: 'MoMo details' })).toHaveCount(0);
        await expect(chat.getByRole('button', { name: /details$/ })).toHaveCount(0);
        await expect(chat.locator('header').getByText('MoMo', { exact: true })).toBeVisible();
      });
    });
  }
}
