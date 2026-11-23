// Settings › My machines, two states a machine's row names (#2709): a Host macOS keeps off its local network ("Can’t reach local network",
// where to allow it as the tooltip, the agents still usable) and a machine that restarted and waits at its login window ("Restarted ·
// waiting for sign-in", after "Offline · seen …" until the app's sign-in probe over ssh has answered). Both themes, one row each.
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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-states-e2e-')));
const HINT = 'Allow “node” in the macOS alert or in Privacy & Security › Local Network';
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const record = (id: string, lastHeartbeat?: number) => ({
  id: `ssh:${id}`,
  name: id,
  address: id,
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  get lastHeartbeat() {
    return lastHeartbeat ?? Date.now();
  },
  setup: '',
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        FAKE_HOST_LOCAL_NETWORK: 'denied',
        FAKE_HOST_ASLEEP: 'me@asleep',
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { ...themeSeed(theme).prefs, sshHosts: ['me@box', 'me@asleep'] } },
        userData: {
          'host-registry.json': {
            version: 1,
            hosts: [record('me@box'), record('me@asleep', Date.now() - 2 * 3_600_000)],
          },
        },
      },
    });

    test('a Host kept off its local network, and a machine waiting at its login window, each say so in one line', async ({ page }) => {
      await openConnections(page);
      const mine = page.getByRole('region', { name: 'Machines' });
      const row = (name: string) => mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: name }) });
      const box = row('me@box');
      const asleep = row('me@asleep');

      await expect(box.locator('.machine-status')).toHaveText('Can’t reach local network', { timeout: 45_000 });
      await expect(box.locator('.machine-dot')).toHaveClass(/\bwarn\b/);
      await expect(box.locator('.machine-sub')).toHaveAttribute('aria-description', HINT);
      // the hint shows in the app's own tooltip on hover
      await box.locator('.machine-sub').hover();
      await expect(page.locator('.tooltip')).toHaveText(HINT);
      await shoot(page, 'machine-states-hint');
      await page.mouse.move(0, 0);
      await expect(page.locator('.tooltip')).toHaveCount(0);
      // a status line, not a new control: the row has no button for it
      await expect(box.locator('.machine-controls .btn-pill')).toHaveCount(0);

      await expect(asleep.locator('.machine-status')).toHaveText('Restarted · waiting for sign-in', { timeout: 60_000 });
      await expect(asleep.locator('.machine-dot')).toHaveClass(/\bwarn\b/);
      await expect(asleep.locator('.machine-sub')).toHaveAttribute(
        'aria-description',
        'The machine restarted and is waiting for someone to sign in.',
      );
      await expect(asleep.locator('.machine-controls .btn-pill')).toHaveCount(0);

      const area = await mine.boundingBox();
      await shoot(page, 'machine-states', area ? { clip: area } : {});
    });
  });
}
