// Fast on an account that can't have it: the fake Claude CLI offers a model with Fast but reports extra usage turned
// off, so the model menu shows no Fast toggle and the / menu no Fast entry (not a greyed toggle with the reason).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

test.use({ harnesses: 'claude', env: { FAKE_CLAUDE_FAST: '1' } });

test('fast-ineligible-account: no Fast toggle or / entry when extra usage is off for the account', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await modelButton(page).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Fast Opus' }).click();
  await expect(modelButton(page)).toContainText('Fake Fast Opus');
  if (!(await page.locator('.effort-pop').isVisible())) await modelButton(page).click();
  const pop = page.locator('.effort-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.effort-name')).toBeVisible();
  // the model supports Fast, the account doesn't: no toggle, and the title keeps its place
  await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset to default' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('model-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  // the / menu: Feedback is there, Fast (and the CLI's own /fast) is not
  await composer(page).fill('/f');
  const titles = page.locator('.slash-panel .add-panel-title');
  await expect(titles.getByText('Feedback', { exact: true })).toBeVisible();
  await expect(titles.filter({ hasText: /^(Fast|Speed|\/fast)$/ })).toHaveCount(0);
});
