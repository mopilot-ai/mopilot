// The Add a machine journey in the real renderer against a fake `ssh` that asks and fails as a real one does: from the new chat's Run on picker, the typed address, the connecting line, a first-seen host key shown inline with its fingerprint (Connect), the failure with its cause and its one fix, a changed host key refused with the command that fixes it, and a question the person cancels. Every state is one sheet; no step leaves the chat for Settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { shoot, themeSeed } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform === 'win32', NO_HOST_HERE);

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'add-journey-e2e-')));
test.afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const FINGERPRINT = 'SHA256:HQwyxhpk6bfAvKWWuPDThdDTaYRFUi0yqek11PJ/bHI';
const SCRIPT = {
  // a machine ssh has not seen: asks first, then (the fake has no sshd behind it) takes keys only
  'me@newkey': { askKey: FINGERPRINT, say: 'me@newkey: Permission denied (publickey).' },
  'me@nokey': { askKey: FINGERPRINT, say: 'me@nokey: Permission denied (publickey).' },
  'me@moved': { changedKey: true },
};

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    HOME,
    FAKE_SSH_SCRIPT: JSON.stringify(SCRIPT),
    FAKE_SSH_TRAIL: path.join(HOME, 'fake-ssh.trail'),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: themeSeed('light') },
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(path.join(HOME, 'fake-ssh.trail')))
    await testInfo.attach('fake-ssh.trail', { path: path.join(HOME, 'fake-ssh.trail') });
});

test('typing, connecting, a new host key, a changed one and a cancelled question, each in the one sheet', async ({ page }) => {
  // 1-2: the Run on picker's Add machine… opens the sheet over the new chat
  await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitem', { name: /Add machine/ })
    .click();
  const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
  const field = sheet.getByLabel('Machine', { exact: true });
  const addButton = sheet.getByRole('button', { name: 'Add', exact: true });
  await expect(page.locator('.composer-wrap')).toBeVisible();
  await expect(sheet.getByRole('tab')).toHaveCount(0);

  // typing: nothing to add yet, then a user name without a host is not an address, then one is
  await expect(addButton).toBeDisabled();
  await field.fill('@');
  await expect(addButton).toBeDisabled();
  await field.fill('me@newkey');
  await expect(addButton).toBeEnabled();
  await shoot(page, 'add-journey-typed');

  // connecting: ssh asks about a machine it has not seen; the fingerprint is on the row
  await addButton.click();
  const ask = sheet.locator('.settings-row', { hasText: 'Connect to newkey?' });
  await expect(ask).toBeVisible({ timeout: 45_000 });
  await expect(ask.locator('.host-fingerprint')).toHaveText(`ED25519 ${FINGERPRINT}`);
  await expect(field).toHaveAttribute('aria-disabled', 'true');
  await shoot(page, 'add-journey-host-key');
  await ask.getByRole('button', { name: 'Connect' }).click();

  // the failure says its cause and offers its one fix
  const line = sheet.locator('.host-install-line');
  await expect(line).toHaveText('me@newkey only takes keys', { timeout: 45_000 });
  await expect(sheet.locator('.host-install-reason')).toContainText('authorized_keys');
  await expect(sheet.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await shoot(page, 'add-journey-keys-only');

  // a machine that changed its key is refused; the fix is the command that forgets the old one
  await field.fill('me@moved');
  await addButton.click();
  await expect(line).toHaveText('me@moved’s identity changed', { timeout: 45_000 });
  await expect(sheet.locator('.host-install-reason')).toContainText('Otherwise don’t connect.');
  await expect(sheet.getByRole('button', { name: 'Copy command' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await shoot(page, 'add-journey-key-changed');

  // a question the person cancels is not a failure of the machine
  await field.fill('me@nokey');
  await addButton.click();
  const again = sheet.locator('.settings-row', { hasText: 'Connect to nokey?' });
  await expect(again).toBeVisible({ timeout: 45_000 });
  await again.getByRole('button', { name: 'Cancel' }).click();
  await expect(line).toHaveText('You didn’t connect to me@nokey', { timeout: 45_000 });
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();

  // closing leaves the new chat where it was
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.composer-wrap')).toBeVisible();
});
