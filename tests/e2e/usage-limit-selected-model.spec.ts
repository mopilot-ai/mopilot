// A usage-limit handoff keeps the destination's selected model through native startup, its first turn and the composer.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Dirs } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.use({
  harnesses: 'both',
  seed: {
    uiState: {
      prefs: { model: 'fake-model-2', claudeSelection: { model: 'opus', effort: 'high' }, autoSwitchHarnessOnLimit: true },
    },
    files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), ''),
  },
});

for (const catalogUnavailable of [false, true]) {
  test.describe(catalogUnavailable ? 'without a model catalog' : 'with a model catalog', () => {
    test.use({ env: catalogUnavailable ? { FAKE_CODEX_FAIL: 'model/list' } : {} });

    test('automatic Claude Code to Codex continuation uses the saved Codex model', async ({ page, harness }) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await openHarnessList(page);
      await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
      await page.locator('.hp-models .menu-item', { hasText: 'Opus' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Opus');
      await composer(page).fill('Keep working on the selected model');
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const continued = () =>
        harness.codexLog().filter((e) => e.method === 'turn/start' && /Continue/.test(e.params.input?.[0]?.text ?? ''));
      await expect.poll(() => continued().length).toBe(1);
      const turn = continued()[0];
      // An earlier new-chat prewarm must not satisfy the assertion for this switch's startup.
      const calls = harness.codexLog();
      const at = calls.findIndex((e) => e.method === 'turn/start' && e.id === turn.id);
      const start = calls
        .slice(0, at)
        .filter((e) => e.method === 'thread/start')
        .at(-1);
      expect(start?.params.model).toBe('fake-model-2');
      expect(turn.params.model).toBe('fake-model-2');
      await expect(page.getByRole('button', { name: 'Select model' })).toContainText(catalogUnavailable ? 'fake-model-2' : 'Model Two');
      await expect(page.getByText(/No models are available/)).toHaveCount(0);
      await expect(page.locator('.switch-chip')).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
      await expect(page.getByRole('main')).toContainText('fake-codex:');
    });
  });
}

test.describe('harness switching is off by default', () => {
  test.use({
    seed: {
      uiState: { prefs: { autoContinueOnLimit: true } },
      files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), ''),
    },
  });

  test('a saved reset preference keeps the limited chat on its harness', async ({ page, harness }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Opus' }).click();
    await page.keyboard.press('Escape');
    await composer(page).fill('Keep the current harness when quota runs out');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main')).toContainText('Claude AI usage limit reached');
    // Wait past main's account-pool settlement window: an immediate absence would miss the old automatic switch.
    await page.waitForTimeout(3_000);
    expect(harness.codexLog().filter((e) => e.method === 'turn/start')).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Opus');
    await expect(page.locator('.switch-chip')).toHaveCount(0);
  });
});
