// Settings › My machines, a Host that is not the app's build and Remove (#4047, #4048): the row says "Host is out of date" with Update, a failed update names its cause and offers Try again, Rotate this Mac's key asks first and names the machines that stop it (#4142), and Remove asks first: it names a running turn, uninstalls the Host on a machine that answers (the fake ssh logs `uninstall` and the deletion of its files) and says the Host stays on one that does not. Both themes.
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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-update-remove-e2e-')));
const harnesses = [{ id: 'claude', detected: true, signedIn: true }];
const record = (id: string, lastHeartbeat?: number, o: object = {}) => ({
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
  ...o,
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

for (const theme of THEMES) {
  test.describe(theme, () => {
    const log = path.join(ROOT, `log-${theme}`);
    const busy = path.join(ROOT, `busy-${theme}`);
    const fail = path.join(ROOT, `fail-${theme}`);
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(harnesses),
        FAKE_HOST_BUILD: 'an-older-build',
        FAKE_HOST_LOG: log,
        FAKE_HOST_BUSY: busy,
        FAKE_HOST_UNINSTALL_FAIL: fail,
        FAKE_HOST_LOCKED: 'me@gone',
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { prefs: { ...themeSeed(theme).prefs, sshHosts: ['me@old', 'me@gone'] } },
        userData: {
          'host-registry.json': {
            version: 1,
            // me@old is paired (it has its Host's name): an update to an unpaired machine says "Pair again" instead (#4237)
            hosts: [
              record('me@old', undefined, { hostKey: 'ab'.repeat(16) }),
              record('me@gone', Date.now() - 2 * 3_600_000, { hostKey: 'cd'.repeat(16) }),
            ],
          },
        },
      },
    });

    test('an older Host offers Update and a failure says why; Remove asks first and uninstalls, or says the Host stays', async ({
      page,
    }) => {
      for (const f of [log, busy, fail]) fs.rmSync(f, { force: true });
      await openConnections(page);
      const mine = page.getByRole('region', { name: 'Machines' });
      const row = (name: string) => mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: name }) });
      const old = row('me@old');

      // the Host reports 0.0.1, older than this app's: Update, and a failure on a paired machine (the fake machine has no build for this app) names its cause
      await expect(old.locator('.machine-status')).toHaveText('Host is out of date', { timeout: 45_000 });
      await shoot(page, 'update-offered');
      await old.getByRole('button', { name: 'Update the Host on me@old' }).click();
      await expect(old.locator('.machine-status')).toHaveText('Update failed', { timeout: 60_000 });
      await expect(old.getByRole('button', { name: 'Try again the Host on me@old' })).toBeVisible();
      await shoot(page, 'update-failed');

      // Rotate this Mac's key asks first, and with a machine that is out of date and one that is offline it says which ones stop it and that nothing changed
      await page.getByRole('button', { name: 'Rotate this Mac’s key' }).click();
      const ask = page.getByRole('group', { name: "Rotate this Mac's key" });
      await expect(ask).toContainText('Every machine must be online and up to date');
      await shoot(page, 'rotate-ask');
      await ask.getByRole('button', { name: 'Rotate', exact: true }).click();
      const outcome = page.getByRole('status', { name: 'Key rotation result' });
      await expect(outcome).toContainText('Every machine must be online and up to date first:', { timeout: 30_000 });
      await expect(outcome).toContainText('me@old');
      await expect(outcome).toContainText('me@gone');
      await shoot(page, 'rotate-blocked');

      // Remove asks first: a turn is running there, so the sheet says so
      fs.writeFileSync(busy, 'on');
      const open = async (name: string) => {
        const more = row(name).getByRole('button', { name: `More for ${name}` });
        await expect(async () => {
          if (await page.getByRole('menu').count()) await more.click();
          await more.click();
          await page.getByRole('menuitem', { name: 'Remove' }).click({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        return page.locator('.dialog', { hasText: `Remove ${name}` });
      };
      const sheet = await open('me@old');
      await expect(sheet.locator('.machine-sheet-lede')).toHaveText([
        'Stops the Host on me@old and deletes its files.',
        'A turn is running there. It will stop.',
      ]);
      await shoot(page, 'remove-sheet');

      // a Host that cannot be stopped stays in the list with its cause, and Remove here only forgets it
      fs.writeFileSync(fail, 'on');
      await sheet.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(sheet.locator('.machine-sheet-error')).toHaveText('No bin.', { timeout: 30_000 });
      await expect(old).toBeVisible();
      await shoot(page, 'remove-failed');
      fs.rmSync(fail);
      await sheet.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(old).toHaveCount(0, { timeout: 30_000 });
      const calls = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).method);
      expect(calls).toEqual(expect.arrayContaining(['uninstall', 'purge']));

      // a machine that does not answer is forgotten here only, and the sheet says its Host stays
      const gone = await open('me@gone');
      await expect(gone.locator('.machine-sheet-lede')).toHaveText([
        "The Host and chats' files stay on me@gone. This only removes it here.",
        'To delete those files later, add the machine again and choose Remove, or delete ~/.mopilot-host and the Host data directory there.',
      ]);
      await shoot(page, 'remove-offline');
      await gone.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(row('me@gone')).toHaveCount(0, { timeout: 30_000 });
      await expect(
        page.getByText("me@gone removed here. Its Host and chats' files remain there; add it again and Remove to delete them."),
      ).toBeVisible();
    });
  });
}
