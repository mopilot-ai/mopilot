// Settings › My machines, a machine's page (X2, host.machinePage): clicking the row opens a page with the machine's Status (its one line and how this Mac reaches it), and nothing else while no other package's data is there: a section with no data is absent. Both themes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { THEMES, shoot, themeSeed } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-page-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const BOX = {
  id: 'ssh:me@box',
  name: 'me@box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        MOPILOT_FLAGS: 'host.machinePage=1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { ...themeSeed(theme).prefs, sshHosts: ['me@box'] } },
        userData: { 'host-registry.json': { version: 1, hosts: [BOX] } },
      },
    });

    test('the row opens the machine’s page with its Status and the Rules the Host answers', async ({ page }) => {
      await openConnections(page);
      const mine = page.getByRole('region', { name: 'Machines' });
      const row = mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: 'me@box' }) });
      await expect(row.locator('.machine-status')).toContainText('Online', { timeout: 45_000 });
      await row.getByRole('button', { name: 'me@box, open its page' }).click();
      const dialog = page.locator('.dialog');
      await expect(dialog.locator('.dialog-head')).toContainText('me@box');
      await expect(dialog.locator('.settings-group-title')).toHaveText(['Status', 'Rules']);
      await expect(dialog).toContainText('Online');
      await shoot(page, 'machine-page-status');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });
  });
}
