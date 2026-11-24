// Settings → Connections for an invited account: a Host machine that is also a saved ssh target is listed once (under Machines, "Online" with the agents that run there by name, a test agent never, and no button when nothing needs the person), and a failed install from the Add machine sheet's SSH tab is one line with Details open.
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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-conn-e2e-')));
const OFFLINE = path.join(ROOT, 'offline');
const harnesses = [
  { id: 'claude', detected: true, signedIn: true },
  { id: 'gemini', detected: true, signedIn: true },
  { id: 'fake', detected: true, signedIn: true },
];
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// each theme starts with the machines up: the run before it leaves OFFLINE behind, and a Host that never answers reads as out of date
test.beforeEach(() => fs.rmSync(OFFLINE, { force: true }));

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_OFFLINE: OFFLINE,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { ...themeSeed(theme).prefs, sshHosts: ['me@box', 'plain@other'] } },
        userData: {
          'host-registry.json': {
            version: 1,
            hosts: [
              {
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
              },
            ],
          },
        },
      },
    });

    test('one row per machine, agents by name, and a failed install is one line', async ({ page }) => {
      await openConnections(page, 'ssh');
      const ssh = page.locator('.settings-group', { hasText: 'SSH connections from this Mac' });
      await expect(ssh).toContainText('plain@other');
      await expect(ssh).not.toContainText('me@box');
      await openConnections(page);
      const mine = page.getByRole('region', { name: 'Machines' });
      await expect(mine.locator('[aria-label="My machines"] .machine-name')).toHaveText(['me@box']);
      await expect(mine.locator('.machine-status')).toHaveText('Online · Claude Code, Gemini', { timeout: 45_000 });
      await expect(mine.locator('.machine-dot')).toHaveClass(/\bok\b/);
      await expect(mine.locator('.machine-controls .btn-pill')).toHaveCount(0);
      await shoot(page, 'connections-settled');
      // the machines go dark: an install now fails, as one line with Details closed (the installed end is in tests/hostInstallCard.test.ts)
      fs.writeFileSync(OFFLINE, '');
      await mine.getByRole('button', { name: 'Add machine' }).click();
      const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
      await sheet.getByLabel('Machine', { exact: true }).fill('nobody@nowhere');
      await sheet.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(sheet.locator('.host-install-line')).toHaveText('Couldn’t install on nobody@nowhere', { timeout: 45_000 });
      await expect(sheet.locator('details')).not.toHaveAttribute('open', '');
      await shoot(page, 'connections-install-failed');
    });
  });
}
