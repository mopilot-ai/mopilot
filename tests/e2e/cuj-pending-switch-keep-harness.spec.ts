// #3914: in a chat with a switch away from Codex pending, Codex's Automatic or account row in the picker keeps the chat on Codex and cancels the switch instead of leaving the menu as it was.
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';
import { openHarnessList } from './fixtures/harnessPicker';

test.use({ harnesses: 'both', env: { SAGE_NO_RELAY: '' }, seed: { files: (d) => twoCodexAccounts(d) } });

test('Automatic on the chat’s own harness cancels the pending switch away from it', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  await page.locator('.hp-models .menu-item').first().click();
  await composer.fill('hello codex');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(/fake-codex: hello codex/)).toBeVisible();

  // ask for a switch to Claude Code: with nothing at risk it goes ahead on the click and the chip shows it pending
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  const chip = page.locator('.switch-chip');
  await expect(chip).toBeVisible();

  // back to the chat's own harness: Automatic there cancels that switch
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  await page.getByRole('menuitemradio', { name: /Automatic.*Moves to another account/ }).click();
  await expect(chip).toHaveCount(0);
});
