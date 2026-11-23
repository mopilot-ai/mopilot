// An IP-addressed machine is shown by its computer's own name (#4930): the machine saved by an older app under the address typed (daxhill@192.168.64.1) is named for the computer once its Host answers, in Settings › My machines and in the composer's picker, while a machine the person named keeps that name; two machines the person named alike are told apart by their address in the list, yet Rename starts from the plain name (#4950). The Host is the fake ssh fixture (FAKE_HOST_COMPUTER_NAME); the install-time naming is covered by tests/hostComputerName.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-cname-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const record = (name: string, address: string, renamed?: boolean) => ({
  id: `ssh:${address}`,
  name,
  address,
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  ...(renamed === undefined ? {} : { renamed }),
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
    FAKE_HOST_COMPUTER_NAME: 'mopilot-mini',
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: {
    uiState: { prefs: { sshHosts: ['daxhill@192.168.64.1', 'me@10.0.0.2', 'me@10.0.0.3'] } },
    userData: {
      'host-registry.json': {
        version: 1,
        // saved by an older app: named for the address typed, no record of a rename; and one the person named
        hosts: [
          record('192.168.64.1', 'daxhill@192.168.64.1'),
          record('Office Mac', 'me@10.0.0.2', true),
          record('Office Mac', 'me@10.0.0.3', true),
        ],
      },
    },
  },
});

test('a machine added by its IP is shown by the computer’s name; a name the person gave stays', async ({ page }, testInfo) => {
  const chip = page.getByRole('button', { name: 'Run on: This Mac, online', exact: true });
  await chip.click();
  const menu = page.getByRole('menu', { name: 'My machines' });
  await expect(menu.getByRole('menuitemradio', { name: /mopilot-mini/ })).toBeVisible({ timeout: 60_000 });
  await expect(menu.getByRole('menuitemradio', { name: /Office Mac/ })).toHaveCount(2);
  await expect(menu.getByRole('menuitemradio', { name: /192\.168\.64\.1/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await openConnections(page);
  const rows = page.getByRole('region', { name: 'Machines' }).locator('.machine-name');
  await expect(rows.filter({ hasText: 'mopilot-mini' })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Office Mac \(.+\)/ })).toHaveCount(2);
  await expect(rows.filter({ hasText: '192.168.64.1' })).toHaveCount(0);
  // Rename starts from the plain name, while the list keeps telling the two apart
  const row = rows.filter({ hasText: /Office Mac \(.+\)/ }).first();
  const shown = (await row.innerText()).trim();
  await page.getByRole('button', { name: `More for ${shown}`, exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.locator('.dialog', { hasText: 'Rename machine' });
  await expect(rename.getByLabel('Machine name')).toHaveValue('Office Mac');
  await page.screenshot({ path: testInfo.outputPath('rename-prefill-plain-name.png'), animations: 'disabled' });
  await rename.getByRole('button', { name: 'Cancel' }).click();
  await expect(rename).toHaveCount(0);
  await expect(row).toHaveText(shown);
});
