// Add a machine, when it fails: the card says the real cause and offers the fix in place (design/remote-run/audit/failcat-mac-states.md M6, M11, M14, M15). A question the person cancels is "You didn't connect", not a host-key or password failure; a machine that takes keys only shows this Mac's key to authorize; a dropped connection says so; a machine whose sshd refuses MoPilot's key says that and does not offer a Try again that cannot help. The fake ssh (fixtures/fake-ssh/ssh, FAKE_SSH_SCRIPT) fails each machine the way a real one does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { shoot, themeSeed } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform === 'win32', NO_HOST_HERE);

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'add-fail-e2e-')));
test.afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const SCRIPT = {
  // what ssh prints once the askpass (electron/host/sshAskpass.cjs, run for real in tests/hostSshPrompts.test.ts) got no answer
  'me@asks': { say: 'MoPilot: no answer was given to ssh.\nHost key verification failed.' },
  'me@keys': { say: 'me@keys: Permission denied (publickey).' },
  'me@drops': {
    say: 'kex_exchange_identification: Connection closed by remote host',
  },
  'me@sshd': { keyRefused: true },
};

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    HOME,
    FAKE_SSH_SCRIPT: JSON.stringify(SCRIPT),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: themeSeed('light') },
});

test('each failed add says its cause and offers its fix', async ({ page }) => {
  // the new chat's Run on menu opens the Add a machine sheet in place
  await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitem', { name: /Add machine/ })
    .click();
  const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
  const add = async (destination: string) => {
    await sheet.getByLabel('Machine', { exact: true }).fill(destination);
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  };
  const line = sheet.locator('.host-install-line');
  const reason = sheet.locator('.host-install-reason');

  // M6: the question was cancelled: nothing failed on the machine
  await add('me@asks');
  await expect(line).toHaveText('You didn’t connect to me@asks', {
    timeout: 45_000,
  });
  await expect(reason).toContainText('The question wasn’t answered.');
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();
  await shoot(page, 'add-failed-declined');

  // M11: a machine that takes keys only shows this Mac's key
  await add('me@keys');
  await expect(line).toHaveText('me@keys only takes keys', { timeout: 45_000 });
  await expect(reason).toContainText('authorized_keys');
  await expect(sheet.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await shoot(page, 'add-failed-keys-only');

  // M14: the connection dropped
  await add('me@drops');
  await expect(line).toHaveText('Lost the connection to me@drops', {
    timeout: 45_000,
  });
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();

  // S2: MoPilot asks before it adds its own key; a Cancel adds nothing and the add stops there
  await add('me@sshd');
  await expect(sheet.getByText('Add a MoPilot key to sshd?')).toBeVisible({ timeout: 45_000 });
  await expect(sheet.getByText(/authorized_keys on sshd\. Cancel adds nothing\./)).toBeVisible();
  // the question's own Cancel (the dialog has one for the whole add, below it)
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await expect(line).toHaveText('MoPilot needs a key to reconnect to me@sshd', { timeout: 45_000 });
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();

  // M15: its sshd refuses MoPilot's key: a machine-side fix, no Try again
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await sheet.getByRole('button', { name: 'Add key', exact: true }).click({ timeout: 45_000 });
  await expect(line).toHaveText('me@sshd won’t sign in with MoPilot’s key', {
    timeout: 45_000,
  });
  await expect(reason).toContainText('PubkeyAuthentication');
  await expect(sheet.getByRole('button', { name: 'Copy details' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await shoot(page, 'add-failed-sshd-refuses-key');
});
