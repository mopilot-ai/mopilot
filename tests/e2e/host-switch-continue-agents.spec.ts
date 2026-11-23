// Switch host… for a Claude Code chat against a FAKE machine that cannot take it (#4906, #4910): a machine whose Claude Code is signed out says so on its row before anything is pressed, and a Host too old for Claude Code is refused before the changes are carried to it. The Host is the repo's fake ssh (fixtures/fake-ssh/ssh), not a real Host, and the agent is the fake Claude Code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-switch-agents-e2e-')));
fs.mkdirSync(path.join(ROOT, 'projects/app/.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const SID = '3b7e1c9a-5d2f-4a6b-8c4e-9f0a1b2c3d4e';

const machine = (claude: { signedIn: boolean; detected?: boolean }, name = 'box') => ({
  id: 'ssh:me@box',
  name,
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'claude', detected: true, ...claude }],
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  });

/** The chat's folder: a repository with one commit, an origin, and a changed file to carry. */
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
}

/** A machine name long enough to wrap its row's cause (#5161). */
const LONG = 'Manageds-Virtual-Machine';
const signedInRegistry = { version: 1, hosts: [machine({ signedIn: true })] };
const signedOutRegistry = { version: 1, hosts: [machine({ signedIn: false })] };

/** The app's seed without its machines (each describe names its registry inline). */
const base = (env: Record<string, string>) => ({
  harnesses: 'claude' as const,
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_REPO: JSON.stringify({ remote: 'https://example.com/org/app.git', branch: 'main', head: 'a'.repeat(40), dirty: 0 }),
    PATH: withPath([FAKE_SSH_BIN]),
    ...env,
  },
  seed: {
    uiState: SYSTEM_THEME,
    files: ({ home }: { home: string }) => repoInHome(home),
    claudeSessions: [{ id: SID, cwd: 'proj', title: 'Repo chat', turns: ['an old message'] }],
  },
});
test.beforeEach(() => fs.rmSync(LOG, { force: true }));
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

async function openDialog(page: Page) {
  await page.getByRole('complementary').getByText('Repo chat', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Host: This Mac/ }).click();
  const row = page.getByRole('menu', { name: 'My machines' }).getByRole('menuitem', { name: /Switch host/ });
  await expect(row).not.toHaveAttribute('aria-disabled', 'true', { timeout: 45_000 });
  await row.click();
  return page.getByRole('dialog', { name: 'Switch host' });
}

const signedOut = base({ FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'claude', detected: true, signedIn: false, signIn: ['login'] }]) });
const old = base({ FAKE_HOST_OLD_FAMILIES: '1' });

test.describe('a machine whose Claude Code is signed out', () => {
  test.use({ ...signedOut, seed: { ...signedOut.seed, userData: { 'host-registry.json': signedOutRegistry } } });

  test('says so on its row before anything is pressed, and nothing can be sent to it', async ({ page }) => {
    const dialog = await openDialog(page);
    const row = dialog.getByRole('radio', { name: /box/ });
    await expect(row).toBeDisabled({ timeout: 45_000 });
    await expect(row).toContainText('Sign in to Claude Code on box');
    await expect(dialog.getByRole('button', { name: 'Switch host', exact: true })).toBeDisabled();
    expect(calls().filter((c) => c.method === 'chat.prepareContinue')).toHaveLength(0);
  });
});

test.describe('a Host from before a continue took Claude Code', () => {
  test.use({ ...old, seed: { ...old.seed, userData: { 'host-registry.json': signedInRegistry } } });

  test('is refused as too old before the changes are carried to it', async ({ page }) => {
    // the machine's folders are this runner's (fixtures/fakeSsh.ts NO_HOST_HERE)
    test.skip(process.platform === 'win32', NO_HOST_HERE);
    const dialog = await openDialog(page);
    await expect(dialog.getByRole('radio', { name: /box/ })).toBeEnabled({ timeout: 45_000 });
    await dialog.getByLabel('Folder on the host').fill(path.join(ROOT, 'projects'));
    await dialog.getByRole('button', { name: 'Switch host', exact: true }).click();
    await expect(dialog.getByText(/uncommitted change/)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Carry changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('box is too old to take this chat. Update it.', { timeout: 30_000 });
    // nothing reached the machine's folder, and the chat is still on this Mac
    expect(calls().some((c) => c.method === 'git.carryApply')).toBe(false);
    expect(calls().some((c) => c.method === 'chat.prepareContinue')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Host: This Mac/ })).toBeVisible();
  });
});

test.describe('a machine with a long name that has no Claude Code (#5161)', () => {
  const missing = base({ FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'claude', detected: false, signedIn: false }]) });
  test.use({
    ...missing,
    seed: {
      ...missing.seed,
      userData: { 'host-registry.json': { version: 1, hosts: [machine({ detected: false, signedIn: false }, LONG)] } },
    },
  });

  test('its cause is read in full on the row, and the folder field names the picked machine', async ({ page }, testInfo) => {
    const dialog = await openDialog(page);
    const row = dialog.getByRole('radio', { name: new RegExp(LONG) });
    await expect(row).toBeDisabled({ timeout: 45_000 });
    await expect(row).toContainText(`Claude Code isn't installed on ${LONG}`);
    // nothing on the row is cut: the cause and the name each fit their box
    const cut = await row.evaluate((r) =>
      [...r.querySelectorAll<HTMLElement>('.switch-host-name, .switch-host-note')].some((e) => e.scrollWidth > e.clientWidth + 1),
    );
    expect(cut).toBe(false);
    await dialog.screenshot({ path: testInfo.outputPath('switch-host-missing-agent.png') });
  });
});
