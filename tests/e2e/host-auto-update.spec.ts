// Host auto-update (#2709): with host.autoUpdate on, a paired machine whose Host is older than the app is sent the update without a click (the fake machine has no build for this app, so the row ends at "Update failed" with its cause, the same as a click); with the person's "Update automatically" off the row stays at "Host is out of date" with its Update button.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-auto-update-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const record = {
  id: 'ssh:me@old',
  name: 'me@old',
  address: 'me@old',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
  hostKey: 'ab'.repeat(16),
};
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

for (const automatic of [true, false]) {
  test.describe(automatic ? 'update automatically on' : 'update automatically off', () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        MOPILOT_FLAGS: 'host.autoUpdate=1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        FAKE_HOST_BUILD: 'an-older-build',
        FAKE_HOST_LOG: path.join(ROOT, `log-${automatic}`),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { autoUpdate: automatic, sshHosts: ['me@old'] } },
        userData: { 'host-registry.json': { version: 1, hosts: [record] } },
      },
    });

    test(automatic ? 'an older Host is updated without a click' : 'an older Host waits for the button', async ({ page }) => {
      test.setTimeout(150_000);
      await openConnections(page);
      const row = page
        .getByRole('region', { name: 'Machines' })
        .locator('.machine-item', { has: page.locator('.machine-name', { hasText: 'me@old' }) });
      if (automatic) {
        await expect(row.locator('.machine-status')).toHaveText('Update failed', { timeout: 90_000 });
        await expect(row.getByRole('button', { name: 'Try again the Host on me@old' })).toBeVisible();
      } else {
        await expect(row.locator('.machine-status')).toHaveText('Host is out of date', { timeout: 45_000 });
        // a heartbeat or two later it is still waiting for the person
        await page.waitForTimeout(8_000);
        await expect(row.locator('.machine-status')).toHaveText('Host is out of date');
        await expect(row.getByRole('button', { name: 'Update the Host on me@old' })).toBeVisible();
      }
    });
  });
}
