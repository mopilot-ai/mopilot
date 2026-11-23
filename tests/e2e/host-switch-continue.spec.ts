// The machine's row and Switch host… against an ONLINE fake machine (fake ssh serving the Host protocol, as in host-folder-picker.spec.ts) for a chat on this Mac whose folder is a Git repository with uncommitted changes: the machine's row in the host menu opens the dialog with it picked; a folder that is not on the machine is refused with its reason and the form stays; Browse… picks a folder on the machine over the dialog; the carry question lists the new files and reports the secret-named one as never sent; Carry changes continues the chat on the machine (the host chip then names it), and the machine was asked to prepare the continue and apply the changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-switch-e2e-')));
fs.mkdirSync(path.join(ROOT, 'projects/app/.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const SID = '3b7e1c9a-5d2f-4a6b-8c4e-9f0a1b2c3d4e';

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  });

/** The chat's folder: a repository with one commit, an origin to carry through, a changed file, a new file and a secret. */
function repoInHome(home: string) {
  const origin = path.join(home, 'origin.git');
  const dir = path.join(home, 'proj');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '--bare', '-b', 'main');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(dir, 'README.md'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n');
}

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_REPO: JSON.stringify({ remote: 'https://example.com/org/app.git', branch: 'main', head: 'a'.repeat(40), dirty: 0 }),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: {
    uiState: SYSTEM_THEME,
    files: ({ home }) => repoInHome(home),
    userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } },
    claudeSessions: [{ id: SID, cwd: 'proj', title: 'Repo chat', turns: ['an old message'] }],
  },
});
test.beforeEach(() => fs.rmSync(LOG, { force: true }));
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

async function openDialog(page: Page) {
  await page.getByRole('complementary').getByText('Repo chat', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  // the machine is online once its tunnel (a fake ssh) is up
  await page.getByRole('button', { name: /^Host: This Mac/ }).click();
  const row = page.getByRole('menu', { name: 'My machines' }).getByRole('menuitem', { name: /Switch host/ });
  await expect(row).not.toHaveAttribute('aria-disabled', 'true', { timeout: 45_000 });
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Switch host' });
  await expect(dialog.getByRole('radio', { name: /box/ })).toBeEnabled({ timeout: 45_000 });
  return dialog;
}

test('in a started chat the machine row opens Switch host with that machine picked; This Mac stays checked and inert', async ({
  page,
  harness,
}) => {
  await page.getByRole('complementary').getByText('Repo chat', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Host: This Mac/ }).click();
  const menu = page.getByRole('menu', { name: 'My machines' });
  const here = menu.getByRole('menuitemradio', { name: /This Mac/ });
  await expect(here).toHaveAttribute('aria-checked', 'true');
  await expect(here).toHaveAttribute('aria-disabled', 'true');
  const box = menu.getByRole('menuitemradio', { name: /box/ });
  // the machine is online once its tunnel (a fake ssh) is up
  await expect(box).not.toHaveAttribute('aria-disabled', 'true', { timeout: 45_000 });
  // and the chat can switch now (its host is known): until then the row only says why
  await expect(menu.getByRole('menuitem', { name: /Switch host/ })).not.toHaveAttribute('aria-disabled', 'true', { timeout: 45_000 });
  await expect(box).not.toHaveAttribute('title');
  await shootBoth(page, harness.app, 'host-menu-started-chat');
  await box.click();
  const dialog = page.getByRole('dialog', { name: 'Switch host' });
  await expect(dialog).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: /box/ })).toHaveAttribute('aria-checked', 'true', { timeout: 45_000 });
  await shootBoth(page, harness.app, 'switch-host-from-row');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Host: This Mac/ })).toBeVisible();
});

test('a folder that is not on the machine is refused with its reason; the form and the chat stay', async ({ page, harness }) => {
  // the machine's folders are this runner's (fixtures/fakeSsh.ts NO_HOST_HERE)
  test.skip(process.platform === 'win32', NO_HOST_HERE);
  const dialog = await openDialog(page);
  await dialog.getByLabel('Folder on the host').fill(path.join(ROOT, 'nope'));
  await dialog.getByRole('button', { name: 'Switch host', exact: true }).click();
  // the changes are asked about first; going without them reaches the machine, which refuses the folder
  await expect(dialog.getByText(/uncommitted changes/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Continue without changes' }).click();
  await expect(dialog.getByRole('alert')).toHaveText("That folder doesn't exist on box.");
  await expect(dialog.getByLabel('Folder on the host')).toHaveValue(path.join(ROOT, 'nope'));
  await shootBoth(page, harness.app, 'switch-host-refused');
  expect(calls().filter((c) => c.method === 'chat.prepareContinue')).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Host: This Mac/ })).toBeVisible();
});

test('Browse… picks the folder, the carry question lists the new files, and Carry changes continues the chat on the machine', async ({
  page,
  harness,
}) => {
  // the machine's folders are this runner's (fixtures/fakeSsh.ts NO_HOST_HERE)
  test.skip(process.platform === 'win32', NO_HOST_HERE);
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Browse…' }).click();
  const picker = page.locator('.dialog').filter({ hasText: 'Folder on box' });
  await expect(picker.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await picker.getByRole('button', { name: 'projects' }).click();
  await expect(picker.locator('.host-picker-row')).toHaveText([/app/]);
  await picker.getByRole('button', { name: 'Use this folder' }).click();
  const projects = path.join(ROOT, 'projects');
  await expect(dialog.getByLabel('Folder on the host')).toHaveValue(projects);

  await dialog.getByRole('button', { name: 'Switch host', exact: true }).click();
  await expect(dialog.getByText('2 files have uncommitted changes. Carry them to box?')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByLabel('New files').locator('li')).toHaveText(['notes.txt']);
  await expect(dialog.getByText('Never sent, the names look like secrets: .env')).toBeVisible();
  await shootBoth(page, harness.app, 'switch-host-carry');
  await dialog.getByRole('button', { name: 'Carry changes' }).click();

  try {
    await expect(dialog).toHaveCount(0, { timeout: 40_000 });
  } catch (e) {
    // say where the continue stopped: what the dialog shows and what the machine was asked
    const shown = await dialog.innerText().catch(() => '(gone)');
    throw new Error(
      `the dialog stayed open: ${JSON.stringify(shown)}; the machine was asked ${calls()
        .map((c) => c.method)
        .join(', ')}`,
      { cause: e },
    );
  }
  await expect(page.getByRole('button', { name: /^Host: box/ })).toBeVisible();
  const asked = calls();
  expect(asked.find((c) => c.method === 'chat.prepareContinue')?.params).toMatchObject({ cwd: projects });
  expect(asked.some((c) => c.method === 'git.carryApply')).toBe(true);
  await shootBoth(page, harness.app, 'switch-host-continued');
});
