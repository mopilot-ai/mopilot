// Pairing a device with Codex's Remote Control (electron/harness/codexRemoteControl.cjs): the card's Manage opens Settings → Connections,
// where a code is shown, a device that uses it is listed, and its access can be revoked. Runs against fake-codex.mjs.
// e2e-covers: src/components/panels/SummaryEnvironment.tsx src/components/panels/SummaryPanel.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.summary-environment');
const dialog = (page: Page, name: string) => page.getByRole('alertdialog', { name });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'codex' });

test('Manage opens the devices page: a code pairs a device, which is listed and can be revoked', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-codex: warm up', { exact: true })).toBeVisible();

  // Manage shows only while the link is up
  await expect(card(page).getByRole('button', { name: 'Manage' })).toHaveCount(0);
  await card(page).getByRole('switch', { name: 'Remote Control' }).click();
  await dialog(page, 'Allow devices to control this computer?').getByRole('button', { name: 'Allow' }).click();
  await card(page).getByRole('button', { name: 'Manage' }).click();

  const link = page.getByRole('switch', { name: 'Allow this computer to be controlled' });
  await expect(page.getByRole('heading', { name: 'Other settings' })).toBeVisible();
  await expect(link).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('No devices added yet')).toBeVisible();

  // Add shows a code; the fake pairs a device as soon as it is asked whether the code was used
  await page.locator('.settings-row', { hasText: 'Add a ChatGPT device' }).getByRole('button', { name: 'Add', exact: true }).click();
  // one read of the dialog: the fake pairs right after the code shows, which closes it
  await expect(page.getByRole('dialog', { name: 'Add a device' })).toContainText(
    /Enter this code in ChatGPT on the device you want to connect\.[\s\S]*AB12-CD34/,
  );
  await expect(page.getByRole('dialog', { name: 'Add a device' })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Test Phone')).toBeVisible();

  // revoke takes it off the list
  await page.getByRole('button', { name: 'Revoke access for Test Phone' }).click();
  await dialog(page, 'Revoke access for Test Phone?').getByRole('button', { name: 'Revoke access' }).click();
  await expect(page.getByText('Test Phone')).toHaveCount(0);
  await expect(page.getByText('No devices added yet')).toBeVisible();

  // and off takes the link down, with the devices
  await link.click();
  await expect(link).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('No devices added yet')).toHaveCount(0);
});
