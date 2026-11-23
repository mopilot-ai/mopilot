// e2e-runner: bench
// #5061 (L37, L38) on a real Host over real ssh: a started chat on a machine has the same model picker as This Mac's. The open-model-picker shortcut (⌃⇧M) opens it, and a basic agent the machine has (one of the VM's own, such as opencode) shows the Limited badge with its "See what's different" link. L36 (Install on <machine> for a missing agent) is not exercised: the isolated VM has the real agents on its PATH, so none is missing. One test, one Host.
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

test("a machine chat's model picker opens on its shortcut, badges a basic agent Limited", async ({ harness }) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Claude Code', 'hello machine');
  await expect(page.getByRole('main')).toContainText('hello machine', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  const picker = page.locator('.popover-layer.picker');
  await expect(picker).toHaveCount(0);

  // L38: the shortcut opens the machine chat's picker (it owns the composer command while the composer has focus). The key is a native menu accelerator, which a synthetic key press never reaches: the hidden menu item it is bound to is clicked, as the accelerator does.
  await page.getByRole('textbox', { name: 'Message', exact: true }).click();
  const clicked = await harness.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'Open model picker') return i;
        const inner = i.submenu && find(i.submenu.items);
        if (inner) return inner;
      }
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    item?.click();
    return item?.accelerator ?? null;
  });
  expect(String(clicked)).toMatch(/Ctrl\+Shift\+M/i);
  await expect(picker.first()).toBeVisible({ timeout: 15_000 });
  console.log(`SHORTCUT-PICKER ${JSON.stringify((await picker.first().innerText()).slice(0, 200))}`);
  // the list of the machine's agents
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  const list = page.locator('.hp-harnesses');
  await expect(list).toBeVisible();

  // L37: the basic agent's row says Limited, and its hover links to what is different
  const fake = list.locator('.hp-row', { hasText: 'opencode' });
  await expect(fake).toHaveCount(1);
  const limited = fake.locator('.hp-badge.basic');
  await expect(limited).toHaveText('Limited');
  await limited.hover();
  const diff = page.getByRole('button', { name: "See what's different" });
  await expect(diff).toBeVisible({ timeout: 10_000 });
  console.log(`LIMITED-ROW ${JSON.stringify(await fake.innerText())}`);
  // Claude Code is a first-tier agent: no badge
  await expect(list.locator('.hp-row', { hasText: 'Claude Code' }).locator('.hp-badge.basic')).toHaveCount(0);

  await shootBoth(page, harness.app, 'host-picker-parity');
});
