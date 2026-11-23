// Remote Control on Codex (electron/harness/codexRemoteControl.cjs): the summary panel's Remote Control switch links the whole app-server to the
// user's devices, asks first, and takes the link down again. Runs against fake-codex.mjs.
// e2e-covers: src/components/panels/SummaryEnvironment.tsx src/components/panels/SummaryPanel.tsx src/session/useRemoteControlRow.ts
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.summary-header');
const cardSwitch = (page: Page) => card(page).getByRole('switch', { name: 'Remote Control' });
const dialog = (page: Page) => page.getByRole('alertdialog', { name: 'Allow devices to control this computer?' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'codex' });

test('the switch asks first, links the computer on Allow, and off takes the link down', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-codex: warm up', { exact: true })).toBeVisible();

  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(card(page)).toContainText('Applies to this computer');

  // Cancel leaves it off
  await cardSwitch(page).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');

  // Allow links it
  await cardSwitch(page).click();
  await dialog(page).getByRole('button', { name: 'Allow' }).click();
  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(card(page)).toContainText('Connected · this computer');

  // off needs no question
  await cardSwitch(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveAttribute('aria-checked', 'false');
});
