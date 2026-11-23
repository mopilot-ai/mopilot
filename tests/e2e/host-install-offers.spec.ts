// e2e-runner: bench
// Install an agent… on a real machine's row (#4913): the sheet offers every agent the machine's Host can install, an ACP agent beside Claude Code and Codex, and pressing Install on one installs it there (the Host's own npm, no root) and the row reads it as running. The Mac app against a real Linux machine over ssh with no Node and no agent on it (the lane's Ubuntu VM): MINI_ADDRESS (an ssh alias or user@host the VM reaches without a prompt) and INSTALL_AGENT_ID (the Host's id for the agent, default opencode) are required; the sheet's list and the time the install took are written to install-offers-observations.json. Named on the command line only, inside the isolated VM.
import fs from 'node:fs';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { shoot, themeSeed } from './fixtures/shoot';

const ADDRESS = process.env.MINI_ADDRESS ?? '';
const AGENT = process.env.INSTALL_AGENT_ID ?? 'opencode';
test.skip(!ADDRESS, 'MINI_ADDRESS (the machine to add) is not set');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_CORE: process.env.MOPILOT_CORE ?? '' },
  seed: { uiState: themeSeed('light') },
});
test.setTimeout(20 * 60_000);
// a bench: it outlasts an e2e shard, so it runs alone, in the VM
test.beforeEach(() => {
  test.skip(test.info().config.shard !== null, 'a bench: run it alone');
});

test('the sheet offers every agent the machine can install; installing an ACP agent runs it there', async ({ page }) => {
  // the new chat's Run on chip: its Add machine… opens the Add a machine sheet in place
  const chip = page.locator('button.host-ctx');
  await expect(chip).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 60_000 });
  await chip.click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitem', { name: /Add machine/ })
    .click();
  const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
  await sheet.getByLabel('Machine', { exact: true }).fill(ADDRESS);
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet).toContainText(/is ready|Start a chat on it/, { timeout: 8 * 60_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // the machine's row in Settings → Connections
  await openConnections(page);
  const mine = page.getByRole('region', { name: 'Machines' });
  const row = mine.locator('.machine-item').first();
  const name = (await row.locator('.machine-name').innerText()).trim();
  await expect(row.locator('.machine-status')).not.toHaveText('', { timeout: 90_000 });
  const rowLine = (await row.locator('.machine-status').innerText()).trim();
  await row.getByRole('button', { name: `More for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Install an agent…' }).click();
  const dialog = page.locator('.dialog', { hasText: `Install on ${name}` });
  await expect(dialog).toBeVisible();
  const offered = (await dialog.locator('.machine-name').allInnerTexts()).map((t) => t.trim());
  await shoot(page, 'install-offers-sheet');
  const button = dialog.getByRole('button', { name: new RegExp(`^Install .* on ${name}$`) });
  const target = dialog.locator('.machine-item', { has: page.locator('.machine-name', { hasText: /opencode|OpenCode/i }) });
  const started = Date.now();
  await target.getByRole('button').click();
  await shoot(page, 'install-offers-running');
  // the row says "Waiting to install…" and "Installing…" while it runs: done is when neither is there and the sheet no longer offers it
  await expect(row.locator('.machine-status')).not.toContainText(/install/i, { timeout: 5 * 60_000 });
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: `More for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Install an agent…' }).click();
  const after = (
    await page
      .locator('.dialog', { hasText: `Install on ${name}` })
      .locator('.machine-name')
      .allInnerTexts()
  ).map((t) => t.trim());
  expect(after, 'opencode is installed, so it is no longer offered').not.toContain('opencode');
  const seconds = Math.round((Date.now() - started) / 1000);
  await shoot(page, 'install-offers-done');
  fs.writeFileSync(
    test.info().outputPath('install-offers-observations.json'),
    JSON.stringify(
      {
        agent: AGENT,
        rowBefore: rowLine,
        offered,
        seconds,
        rowAfter: (await row.locator('.machine-status').innerText()).trim(),
        buttons: await button.count(),
      },
      null,
      2,
    ),
  );
  await test.info().attach('install-offers-observations.json', { path: test.info().outputPath('install-offers-observations.json') });
  expect(offered.length, `offered: ${offered.join(', ')}`).toBeGreaterThan(2);
});
