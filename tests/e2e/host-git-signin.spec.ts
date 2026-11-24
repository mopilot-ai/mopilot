// Git's missing sign-in, shown in the real app against a fake Host (#4123): the machine's row in Settings › Machines says so once its Host reported it, and a Host chat whose agent's git failed for it says so above the composer; screenshots of both in both themes.
// e2e-covers: src/components/composer/GitSignInNote.tsx src/components/composer/RemoteGitSignin.tsx
// e2e-covers: electron/host/signin.cjs
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { openConnections } from './fixtures/settings';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-signin-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
const SIGNED_IN = path.join(ROOT, 'github-signed-in');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')));
const SOCK = path.join(RESIDENT, 'h.sock');

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'kimi', detected: true, signedIn: true }],
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

let resident: ChildProcess | null = null;
test.beforeAll(async () => {
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: SOCK, FAKE_HOST_LOG: LOG },
    stdio: 'ignore',
  });
  (await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 10_000 })).destroy();
});
test.afterAll(() => {
  resident?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(RESIDENT, { recursive: true, force: true });
});

const ENV = {
  MOPILOT_HOST_DEV: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_CHATS_SOCK: SOCK,
  FAKE_HOST_GIT_SIGNIN: 'no',
  FAKE_HOST_GIT_LOGIN_DONE: SIGNED_IN,
  FAKE_HOST_LOGIN_CODE: 'ABCD-1234',
  FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'kimi', detected: true, signedIn: true }]),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const main = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Pick Kimi Code and the folder on the machine, as the new chat's target. */
async function pickTarget(page: Page) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(path.join(ROOT, 'projects'));
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  // the folder the picker shows is the one "Use this folder" hands back
  await expect(dialog.locator('.host-picker-path')).toHaveText(FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // the project chip names only the folder; the Run on chip beside it names the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveText('app');
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', 'Change project: app · box');
  await expect(page.locator('button.host-ctx')).toHaveAttribute('aria-label', /^Run on: box, /);
}

test.beforeEach(() => {
  fs.rmSync(OFFLINE, { force: true });
  fs.rmSync(LOG, { force: true });
  fs.rmSync(SIGNED_IN, { force: true });
});
// a restart and a machine that drops take longer than a single turn
test.setTimeout(240_000);

/** What main reports as ignored (a failure it survives) goes to the test output, where a run on a runner can be read. */
const showIgnored = (harness: { app: { process(): NodeJS.Process | any } }) =>
  harness.app.process().stdout?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) if (line.includes('[ignored]')) console.log(line);
  });

test('the machine row and the Host chat say git has no sign-in', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  // the chat: its agent's git failed for a missing sign-in, and the line above the composer names the machine
  await pickTarget(page);
  await send(page, 'nosignin please');
  await expect(main(page).getByText('fake-host: nosignin please', { exact: true })).toBeVisible({ timeout: 45_000 });
  const note = page.locator('[data-git-signin-note]');
  await expect(note.locator('.fa-title')).toHaveText('Git isn’t signed in to github.com on box', { timeout: 30_000 });
  await shootBoth(page, harness.app, 'git-signin-chat');
  // the row: read once when the page opens, with the same line
  await openConnections(page);
  const row = page.locator('.machine-list[aria-label="My machines"] .machine-item', { hasText: 'box' });
  await expect(row.locator('.machine-git')).toHaveText('Git isn’t signed in to github.com', { timeout: 45_000 });
  // the row sits below the fold of the page: scrolled to the middle so the picture shows it
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shootBoth(page, harness.app, 'git-signin-row');
  // asked of the Host once, for this machine: no timer
  const asked = (readJsonLineLog(LOG) as { method: string; params?: Record<string, any> }[]).filter((c) => c.method === 'host.status');
  expect(asked.length).toBeLessThanOrEqual(1);
});

test('GitHub recovery shows the device code and leaves the draft in place after sign-in', async ({ harness }) => {
  const page = harness.page;
  await page.setViewportSize({ width: 1024, height: 682 });
  await pickTarget(page);
  await send(page, 'nosignin recovery');
  const note = page.locator('[data-git-signin-note]');
  await expect(note.getByRole('button', { name: 'Sign in to GitHub', exact: true })).toBeVisible({ timeout: 45_000 });
  await composer(page).fill('My unsent draft');
  await note.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
  await expect(note.locator('code')).toHaveText('ABCD-1234');
  await expect(note.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
  await expect(note.getByRole('textbox')).toHaveCount(0);
  await shootBoth(page, harness.app, 'git-signin-waiting');
  await note.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(note).toContainText('Sign-in cancelled');
  await note.getByRole('button', { name: 'Sign in again', exact: true }).click();
  await expect(note.locator('code')).toHaveText('ABCD-1234');
  fs.writeFileSync(SIGNED_IN, 'yes');
  await expect(note.locator('.fa-title')).toHaveText('Git is signed in to github.com on box');
  await expect(note.getByRole('button')).toHaveCount(0);
  await expect(composer(page)).toHaveText('My unsent draft');
  await shootBoth(page, harness.app, 'git-signin-recovered');
  const calls = readJsonLineLog(LOG) as { method: string; params?: Record<string, any> }[];
  expect(calls.filter((c) => c.method === 'host.login')).toHaveLength(2);
  expect(calls.filter((c) => c.method === 'host.login').every((c) => c.params?.harness === 'git:github.com')).toBe(true);
});

test.describe('Host predates GitHub sign-in', () => {
  test.use({ env: { ...ENV, FAKE_HOST_BUILD: 'before-git-signin', FAKE_HOST_OLD_GIT_SIGNIN: '1' } });

  test('a Git sign-in refusal takes the user to the named machine’s update', async ({ harness }) => {
    const page = harness.page;
    await pickTarget(page);
    await send(page, 'nosignin on old Host');
    const note = page.locator('[data-git-signin-note]');
    await note.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click({ timeout: 45_000 });
    await expect(note).toContainText('The last sign-in attempt required a Host update.');
    await expect(note.getByRole('button', { name: 'Sign in again', exact: true })).toHaveCount(0);
    await note.getByRole('button', { name: 'My machines', exact: true }).click();
    const row = page.locator('.machine-list[aria-label="My machines"] .machine-item', { hasText: 'box' });
    await expect(row.getByRole('button', { name: 'Update the Host on box', exact: true })).toBeEnabled({ timeout: 45_000 });
    const calls = readJsonLineLog(LOG) as { method: string }[];
    expect(calls.filter((c) => c.method === 'host.login')).toHaveLength(0);
  });
});
