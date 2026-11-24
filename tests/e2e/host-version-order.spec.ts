// Settings › My machines, a Host that is not the app's build says which side is older (#4923): a newer Host reads "Host is newer · Update MoPilot" with no Update (it would replace the Host with this app's older build, and the call is refused), an older one "Host is out of date" with Update, and one of the app's version and another build "Host differs from this app" with a tooltip that names what Update does. Rotating the key stops on the newer Host and names it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { shoot, themeSeed } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machines are this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-version-order-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version as string;
const record = (id: string) => ({
  id: `ssh:${id}`,
  name: id,
  address: id,
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  // read when the seed is written, not when the spec loads (fixtures/heartbeat guard)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
  hostKey: 'ab'.repeat(16),
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
    FAKE_HOST_LOG: path.join(ROOT, 'log'),
    FAKE_HOST_VERSIONS: JSON.stringify({
      'me@newer': { build: 'a-newer-build', appVersion: '99.0.0' },
      'me@older': { build: 'an-older-build', appVersion: '0.0.1' },
      'me@differs': { build: 'a-rebuilt-build', appVersion: APP_VERSION },
    }),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: {
    uiState: { prefs: { ...themeSeed('light').prefs, autoUpdate: false, sshHosts: ['me@newer', 'me@older', 'me@differs'] } },
    userData: { 'host-registry.json': { version: 1, hosts: ['me@newer', 'me@older', 'me@differs'].map(record) } },
  },
});

test('a Host newer than the app offers no Update, an older one does, and one that cannot be ordered says what Update does', async ({
  page,
}) => {
  await openConnections(page);
  const mine = page.getByRole('region', { name: 'Machines' });
  const row = (name: string) => mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: name }) });

  const newer = row('me@newer');
  await expect(newer.locator('.machine-status')).toHaveText('Host is newer · Update MoPilot', { timeout: 45_000 });
  await expect(newer.getByRole('button', { name: 'Update the Host on me@newer' })).toHaveCount(0);

  const older = row('me@older');
  await expect(older.locator('.machine-status')).toHaveText('Host is out of date', { timeout: 45_000 });
  await expect(older.getByRole('button', { name: 'Update the Host on me@older' })).toBeVisible();

  const differs = row('me@differs');
  await expect(differs.locator('.machine-status')).toHaveText('Host differs from this app', { timeout: 45_000 });
  await expect(differs.locator('.machine-sub')).toHaveAttribute('aria-description', 'Update replaces the Host with this app’s build.');
  await expect(differs.getByRole('button', { name: 'Update the Host on me@differs' })).toBeVisible();
  await shoot(page, 'version-order');

  // the key is not rotated through an update that would replace the newer Host
  await page.getByRole('button', { name: 'Rotate this Mac’s key' }).click();
  await page.getByRole('group', { name: "Rotate this Mac's key" }).getByRole('button', { name: 'Rotate', exact: true }).click();
  const outcome = page.getByRole('status', { name: 'Key rotation result' });
  await expect(outcome).toContainText('Update MoPilot first: me@newer.', { timeout: 30_000 });
  await shoot(page, 'rotate-blocked-newer');
});
