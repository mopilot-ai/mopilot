// New cloud machine in the real renderer (host.cloud; Remote Run X6): with the flag on the Run on chip's menu has a Cloud group and New cloud machine…, which opens the sheet at its Provider step (the key form, the first time) and refuses a key that is not a PEM key in words; with the flag off none of it exists. The create, cancel and done steps need a provider and a joining Host that the main process cannot yet be given as fakes (see the PR notes), so they are covered by tests/newCloudMachine.test.ts.
import { test, expect } from './fixtures/app';

test.describe('flag on', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.cloud=1' } });

  test('the chip menu offers New cloud machine…; the sheet asks for the key first and refuses a bad one', async ({ page }) => {
    await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'My machines' });
    await expect(menu.locator('.menu-section-label')).toHaveText('Cloud');
    await menu.getByRole('menuitem', { name: /New cloud machine/ }).click();
    const sheet = page.locator('.dialog', { hasText: 'New cloud machine' });
    await expect(sheet.getByLabel('Private key')).toBeVisible();
    const fields = ['tenancy', 'user', 'fingerprint', 'region', 'compartmentId', 'subnetId'];
    for (const f of fields) await sheet.getByLabel(f, { exact: true }).fill(`${f}-test`);
    await sheet.getByLabel('Private key').fill('not a key');
    await sheet.getByRole('button', { name: 'Save key' }).click();
    await expect(sheet.getByRole('alert')).toHaveText('The private key is not a PEM key.');
  });
});

test.describe('flag off', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.cloud=0' } });

  test('the chip menu has no Cloud group', async ({ page }) => {
    await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'My machines' });
    await expect(menu.getByRole('menuitem', { name: /Add machine/ })).toBeVisible();
    await expect(menu.getByText('New cloud machine…')).toHaveCount(0);
    await expect(menu.locator('.menu-section-label')).toHaveCount(0);
  });
});
