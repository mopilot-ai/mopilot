// Settings › My machines, Keep running after restart on a Mac added over SSH (#2709): the ⋯ menu item, the sheet with the administrator password and FileVault's limit, a wrong password kept in the sheet, the right one turning it on (the menu item checked), and a Mac FileVault holds after a restart ("Restarted · disk locked"). Both themes. The machine is the fake ssh (fixtures/fake-ssh/ssh), whose sudo takes FAKE_HOST_ADMIN_PASSWORD on standard input.
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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-keep-running-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const record = (id: string, lastHeartbeat?: number, o: object = {}) => ({
  id: `ssh:${id}`,
  name: id,
  address: id,
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  // read when the seed is written: a worker that waits longer than the heartbeat's lifetime still writes a live machine
  get lastHeartbeat() {
    return lastHeartbeat ?? Date.now();
  },
  setup: '',
  ...o,
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

for (const theme of THEMES) {
  test.describe(theme, () => {
    const boot = path.join(ROOT, `boot-${theme}`);
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        FAKE_HOST_PLATFORM: 'darwin',
        FAKE_HOST_BOOT_FILE: boot,
        FAKE_HOST_FILEVAULT: 'on',
        FAKE_HOST_ADMIN_PASSWORD: 'correct horse',
        FAKE_HOST_LOCKED: 'me@locked',
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { ...themeSeed(theme).prefs, sshHosts: ['me@mini', 'me@locked'] } },
        userData: {
          'host-registry.json': {
            version: 1,
            hosts: [
              record('me@mini'),
              record('me@locked', Date.now() - 2 * 3_600_000, { platform: 'darwin', startup: { atBoot: 'yes', fileVault: 'on' } }),
            ],
          },
        },
      },
    });

    test('turn on Keep running after restart with the administrator password; a FileVault Mac says its disk is locked', async ({
      page,
    }) => {
      fs.rmSync(boot, { force: true });
      await openConnections(page);
      const mine = page.getByRole('region', { name: 'Machines' });
      const row = (name: string) => mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: name }) });
      const mini = row('me@mini');
      const locked = row('me@locked');

      await expect(mini.locator('.machine-status')).toHaveText('Online · Claude Code', { timeout: 45_000 });
      const item = page.getByRole('menuitemcheckbox', { name: 'Keep running after restart' });
      const more = mini.getByRole('button', { name: 'More for me@mini' });
      /** Opens the row's ⋯ menu until `check` holds, closing it in between with its own button (Escape would close the page too). */
      const menuUntil = (check: () => Promise<void>) =>
        expect(async () => {
          if (await page.getByRole('menu').count()) await more.click();
          await more.click();
          await check();
        }).toPass({ timeout: 60_000 });
      // the row's menu offers it once the Host said it runs on a Mac and how it starts
      await menuUntil(() => expect(item).toBeVisible({ timeout: 2_000 }));
      await expect(item).toHaveAttribute('aria-checked', 'false');
      await shoot(page, 'keep-running-menu');
      await item.click();

      const sheet = page.locator('.dialog', { hasText: 'Keep running after restart' });
      await expect(sheet.locator('.machine-sheet-lede')).toHaveText([
        'Starts before anyone signs in. Needs an administrator password once.',
        'FileVault is on: after a power loss, someone must unlock the disk first.',
      ]);
      const password = sheet.getByLabel('Administrator password for me@mini');
      await expect(password).toHaveAttribute('type', 'password');
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled();
      await shoot(page, 'keep-running-sheet');

      // a wrong password: said in the sheet, the field emptied for another try
      await password.fill('wrong');
      await sheet.getByRole('button', { name: 'Turn on' }).click();
      await expect(sheet.locator('.machine-sheet-error')).toHaveText('That password didn’t work.', { timeout: 30_000 });
      await expect(password).toHaveValue('');
      await shoot(page, 'keep-running-wrong-password');

      await password.fill('correct horse');
      await password.press('Enter');
      await expect(page.locator('.dialog')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByText('me@mini keeps running after restart')).toBeVisible();
      expect(fs.existsSync(boot)).toBe(true);
      // the next heartbeat brings it back checked
      await menuUntil(() => expect(item).toHaveAttribute('aria-checked', 'true', { timeout: 2_000 }));
      await shoot(page, 'keep-running-on');
      await more.click();

      await expect(locked.locator('.machine-status')).toHaveText('Restarted · disk locked', { timeout: 60_000 });
      await expect(locked.locator('.machine-sub')).toHaveAttribute(
        'aria-description',
        'The machine restarted and FileVault keeps its disk locked until someone unlocks it at the machine.',
      );
      const area = await mine.boundingBox();
      await shoot(page, 'keep-running-rows', area ? { clip: area } : {});
    });
  });
}
