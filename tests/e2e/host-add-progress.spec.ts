// The Add machine card while an add runs, in the real renderer against a fake `ssh` that takes the connection and then says nothing: the phase line (Step 1 of 6 · Connecting), the stall line after 30 s with Keep waiting and Cancel, and Cancel ending the add as one quiet "Cancelled." line, never a failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { shoot, themeSeed } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform === 'win32', NO_HOST_HERE);

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'add-progress-e2e-')));
test.afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    HOME,
    FAKE_SSH_SCRIPT: JSON.stringify({ 'me@slow': { hang: true } }),
    FAKE_SSH_TRAIL: path.join(HOME, 'fake-ssh.trail'),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: themeSeed('light') },
});

test.setTimeout(180_000);
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(path.join(HOME, 'fake-ssh.trail')))
    await testInfo.attach('fake-ssh.trail', { path: path.join(HOME, 'fake-ssh.trail') });
});

test('a silent machine shows its phase, then the stall with Keep waiting and Cancel, and Cancel ends it quietly', async ({ page }) => {
  await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitem', { name: /Add machine/ })
    .click();
  const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
  await sheet.getByLabel('Machine', { exact: true }).fill('ssh://me@slow:22/');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  const line = sheet.locator('.host-install-line');

  // the first phase, named; Cancel is there from the start
  await expect(line).toHaveText('Step 1 of 6 · Connecting', { timeout: 45_000 });
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await shoot(page, 'add-progress-connecting');

  // nothing moves for 30 s: the line says so and offers to keep waiting
  await expect(line).toHaveText('Taking longer than usual…', { timeout: 60_000 });
  await expect(sheet.getByRole('button', { name: 'Keep waiting' })).toBeVisible();
  await shoot(page, 'add-progress-stalled');
  await sheet.getByRole('button', { name: 'Keep waiting' }).click();
  await expect(line).toHaveText('Step 1 of 6 · Connecting');

  // Cancel stops the add; nothing had been installed, so it is not a failure and has nothing to undo
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(line).toHaveText('Cancelled.', { timeout: 30_000 });
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await shoot(page, 'add-progress-cancelled');
});
