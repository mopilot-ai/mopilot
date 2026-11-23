// Switch host… in the real renderer for an invited account with one remote machine in the registry (no tunnel, so it shows offline): off in a new chat with its reason, off while a turn runs, then on (the offline machine's row stays off and opens nothing) and opening the dialog, which lists the machine disabled with its reason and keeps Switch host off until a host and folder are chosen.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';

const BOX = {
  id: 'box',
  name: 'build-box',
  address: 'me@build-box',
  socketPath: '',
  capabilities: {},
  harnesses: [],
  lastHeartbeat: null,
  setup: '',
};
test.use({
  harnesses: 'claude',
  env: { MOPILOT_HOST_DEV: '1' },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [BOX] } } },
});

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
// a started chat's host chip in the composer footer; a new chat's Run on chip in the context bar
const chip = (page: Page) => page.getByRole('button', { name: /^Host: This Mac/ });
const runOn = (page: Page) => page.getByRole('button', { name: /^Run on: This Mac/ });

test('Switch host…: off in a new chat and while a turn runs, then it opens the dialog, which lists the machine with why it cannot be picked', async ({
  page,
  harness,
}) => {
  await runOn(page).click();
  const sw = menu(page).getByRole('menuitem', { name: /Switch host/ });
  await expect(sw).toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('title', 'Send a message first');
  await page.keyboard.press('Escape');

  await composer(page).fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('hello').first()).toBeVisible();
  // the turn ends on its own; until then the row says to stop it
  await chip(page).click();
  await expect(sw).not.toHaveAttribute('aria-disabled', 'true', { timeout: 30_000 });
  await shootBoth(page, harness.app, 'switch-host-menu');
  // an offline machine's row says so and opens nothing
  const boxRow = menu(page).getByRole('menuitemradio', { name: /build-box/ });
  await expect(boxRow).toHaveAttribute('aria-disabled', 'true');
  await expect(boxRow).toContainText('Offline');
  await boxRow.click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Switch host' })).toHaveCount(0);
  await sw.click();

  const dialog = page.getByRole('dialog', { name: 'Switch host' });
  await expect(dialog).toBeVisible();
  const row = dialog.getByRole('radio', { name: /build-box/ });
  await expect(row).toBeDisabled();
  await expect(row).toContainText('Offline');
  await expect(dialog.getByText('Pick a host.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Switch host', exact: true })).toBeDisabled();
  await shootBoth(page, harness.app, 'switch-host-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});
