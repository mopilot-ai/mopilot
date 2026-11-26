// The Organize sidebar menu's By machine (#5576): the sidebar is by project until it is chosen, the choice is the sidebar's from then on, and it is still there after the app starts again.
// e2e-covers: src/components/sidebar/SidebarSections.tsx src/components/sidebar/Sidebar.tsx src/components/sidebar/useSidebarOrganize.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-by-machine-menu-e2e-')));
const FAKE_SSH = path.join(__dirname, 'fixtures/fake-ssh');
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [],
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.use({
  harnesses: 'codex',
  shellPath: [FAKE_SSH],
  env: { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, PATH: `${FAKE_SSH}:${process.env.PATH}` },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
test.setTimeout(240_000);

test('the sidebar is by project until By machine is chosen, and the choice stays after the app starts again', async ({ harness }) => {
  const page = harness.page;
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.side-label', { hasText: 'Projects' })).toBeVisible({ timeout: 45_000 });
  await expect(sidebar.locator('.machine-group')).toHaveCount(0);

  await page.getByRole('button', { name: 'Project sidebar options' }).click();
  await page.getByRole('menuitem', { name: 'Organize sidebar' }).click();
  await page
    .getByRole('menuitemcheckbox', { name: 'By machine' })
    .or(page.getByRole('menuitem', { name: 'By machine' }))
    .click();
  await expect(sidebar.locator('.side-label', { hasText: 'Machines' })).toBeVisible();
  await expect(sidebar.locator('[data-machine-group="this-mac"]')).toBeVisible();
  await expect(sidebar.locator('[data-machine-group="ssh:me@box"]')).toBeVisible({ timeout: 45_000 });

  await harness.relaunch();
  await expect(harness.page.locator('.sidebar .side-label', { hasText: 'Machines' })).toBeVisible({ timeout: 60_000 });
});
