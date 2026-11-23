// e2e-runner: bench
// #5060 (L41, L42) on a real Host over real ssh: a started chat on a machine has the same permission control as This Mac's. The menu head carries a "Learn more" link; picking Full access shows the "Full access is on" banner above the composer (Learn more, Don't show again, Dismiss) and picking another mode removes it. One test, one Host.
// The isolated VM only (MOPILOT_ACCEPT_VM=1: it turns on sshd, and its user is `admin`). Named on the command line only.
import fs from 'node:fs';
import os from 'node:os';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only (its user is `admin`): it turns on sshd and writes the ssh config');

let remote: RemoteHost;
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost();
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});

test.setTimeout(10 * 60_000);
test.use({
  harnesses: 'both',
  env: { MOPILOT_HOST_DEV: '1', HOME: os.homedir() },
  seed: {
    uiState: SYSTEM_THEME,
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            // the VM's user is `admin`: the seed is read with nothing else defined, so it is spelled out
            id: 'ssh:admin@localhost',
            name: 'localhost',
            address: 'admin@localhost',
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            harnesses: [],
            // read when the seed is written, not when the worker loads this file (hostFixtureHeartbeat.invariant.test.ts)
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

test("a machine chat's permission menu has Learn more and Full access shows the warning banner", async ({ harness }) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Claude Code', 'hello machine');
  await expect(page.getByRole('main')).toContainText('hello machine', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });

  const banner = page.locator('.fa-banner');
  await expect(banner).toHaveCount(0);

  // L42: the menu head names the menu and links to its docs
  await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
  const head = page.locator('.perm-menu-head');
  await expect(head).toBeVisible();
  const learn = head.getByText('Learn more', { exact: true });
  await expect(learn).toBeVisible();
  console.log(`MENU-HEAD ${JSON.stringify(await head.innerText())}`);

  // L41: Full access turns the banner on
  await page.locator('.perm-item.full-access').click();
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner.locator('.fa-title')).toHaveText('Full access is on');
  await expect(banner.getByText('Learn more', { exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: /Don.t show again/ })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await expect(banner).toContainText('about elevated risks');
  console.log(`BANNER ${JSON.stringify(await banner.innerText())}`);
  await shootBoth(page, harness.app, 'host-permission-full-access');

  // another mode takes it away again
  await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
  await page.locator('.perm-item.read-only').click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
});
