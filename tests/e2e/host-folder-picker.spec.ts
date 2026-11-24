// The folder picker for a remote machine in the real renderer (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1), against a fake `ssh` that serves the Host protocol on the forwarded socket: the project menu offers "Folder on box…" for the online machine, the picker browses the machine's folders, a refused clone says why and keeps the form, a clone shows its progress, and the folder picked there is the new chat's target.
// e2e-covers: src/components/composer/ProjectMenu.tsx
// e2e-covers: src/components/sidebar/sidebarRepositories.ts src/components/sidebar/projectGroups.ts
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { connectSocket } from '../support/connectSocket';
import { test, expect } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-picker-e2e-')));
for (const d of ['notes', 'projects/app/.git']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

const ENV = { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, PATH: withPath([FAKE_SSH_BIN]) };
test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  // the tunnel finds `ssh` through the login shell's PATH and the process one; the fake comes first in both
  env: ENV,
  seed: {
    uiState: SYSTEM_THEME,
    userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } },
    files: (directories) => {
      fs.writeFileSync(
        path.join(directories.userData, 'projects.json'),
        JSON.stringify({ projects: [{ id: 'sage', name: 'Sage', path: path.join(ROOT, 'notes') }] }),
      );
    },
  },
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.describe('checkout grouping on one Host', () => {
  const checkout = path.join(ROOT, 'projects', 'app');
  const subfolder = path.join(checkout, 'src');
  const log = path.join(ROOT, 'checkout-host.log');
  const residentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')));
  const socket = path.join(residentDir, 'h.sock');
  let resident: ChildProcess;

  test.use({ env: { ...ENV, FAKE_HOST_CHECKOUT: checkout, FAKE_HOST_CHATS_SOCK: socket } });
  test.beforeAll(async () => {
    fs.mkdirSync(subfolder);
    resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
      env: { ...process.env, FAKE_HOST_CHATS_SOCK: socket, FAKE_HOST_LOG: log },
      stdio: 'ignore',
    });
    (await connectSocket(socket, 'the resident Host to accept a connection', { timeoutMs: 10_000 })).destroy();
  });
  test.afterAll(() => {
    resident?.kill();
    fs.rmSync(residentDir, { recursive: true, force: true });
  });

  test('chats in the checkout and its subfolder share one project without an origin', async ({ harness }) => {
    test.setTimeout(120_000);
    const page = harness.page;
    const start = async (folders: string[], cwd: string, text: string) => {
      await page.locator('.ctxbar .ctx-btn').first().click();
      await page.getByRole('button', { name: 'Folder on box…' }).click({ timeout: 45_000 });
      const dialog = page.locator('.dialog');
      for (const name of folders) await dialog.getByRole('button', { name, exact: true }).click({ timeout: 45_000 });
      await expect(dialog.locator('.host-picker-path')).toHaveText(cwd);
      await dialog.getByRole('button', { name: 'Use this folder' }).click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`fake-host: ${text}`, { exact: true })).toBeVisible({ timeout: 45_000 });
    };
    await start(['projects', 'app'], checkout, 'checkout root chat');
    await standaloneNewChat(page).click();
    await start(['projects', 'app', 'src'], subfolder, 'checkout subfolder chat');
    const starts = readJsonLineLog(log).filter((call) => call.method === 'chat.start');
    expect(starts.map((call) => call.params.cwd)).toEqual([checkout, subfolder]);

    const assertGrouped = async (current: Page) => {
      const projects = current.locator('.project-group').filter({ has: current.locator('.project-row[aria-label="app"]') });
      await expect(projects).toHaveCount(1);
      await expect(projects.locator('.thread-row')).toHaveCount(2);
      await expect(current.locator('.project-row[aria-label="src"]')).toHaveCount(0);
    };
    await assertGrouped(page);
    await harness.relaunch();
    await assertGrouped(harness.page);
  });
});

test('reopening the project menu checks the remote folder instead of the default saved project', async ({ page }) => {
  const projectChip = page.locator('.ctxbar .ctx-btn').first();
  const menu = page.locator('.project-menu');
  const sage = menu.getByRole('option', { name: /^Sage/ });
  const machine = menu.getByRole('button', { name: 'Folder on box…' });
  await expect(projectChip).toHaveText('Sage');
  await projectChip.click();
  await expect(sage.locator('.menu-check svg')).toBeVisible();
  await machine.click({ timeout: 45_000 });

  const dialog = page.locator('.dialog');
  await dialog.getByRole('button', { name: 'projects' }).click({ timeout: 45_000 });
  await dialog.getByRole('button', { name: 'app', exact: true }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(path.join(ROOT, 'projects', 'app'));
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(projectChip).toHaveText('app');
  await projectChip.click();
  await expect(sage.locator('.menu-check svg')).toHaveCount(0);
  await expect(sage).toHaveAttribute('aria-selected', 'false');
  await expect(machine).toHaveAttribute('aria-current', 'true');
  await expect(machine.locator('.menu-check svg')).toBeVisible();
  await sage.click();
  await expect(projectChip).toHaveText('Sage');
});

test('browse, a refused clone, a clone with progress, and the folder becomes the target', async ({ page, harness }) => {
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  // the tunnel (a fake ssh) comes up first: a listing may wait for it
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await expect(dialog.locator('.host-picker-row')).toHaveText([/notes/, /projects/]);
  await shootBoth(page, harness.app, 'picker-root');
  await dialog.getByRole('button', { name: 'projects' }).click();
  await expect(dialog.locator('.host-picker-row')).toHaveText([/app\s*Worktree…/]);
  await expect(dialog.getByRole('button', { name: 'Up one folder' })).toBeEnabled();

  // the folders stay open with the clone form up: the clone goes into the one shown
  await dialog.getByRole('button', { name: 'Up one folder' }).click();
  await dialog.getByRole('button', { name: 'Clone repository…' }).click();
  await dialog.getByRole('button', { name: 'projects' }).click();
  await expect(dialog.locator('.host-picker-row')).toHaveText([/app\s*Worktree…/]);
  await expect(dialog.getByLabel('Repository address')).toBeVisible();
  await dialog.getByLabel('Repository address').fill('https://example.com/fail/tool.git');
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This machine can’t sign in to that repository.');
  await expect(dialog.getByLabel('Repository address')).toHaveValue('https://example.com/fail/tool.git');

  await dialog.getByLabel('Repository address').fill('https://example.com/org/tool.git');
  await expect(dialog.getByLabel('Folder name')).toHaveValue('tool');
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(dialog.locator('.host-picker-progress')).toHaveText('Receiving objects 60%');
  await shootBoth(page, harness.app, 'picker-clone-progress');
  await expect(dialog).toHaveCount(0);
  expect(fs.existsSync(path.join(ROOT, 'projects', 'tool', '.git'))).toBe(true);
  // the project chip names only the folder; the Run on chip beside it names the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveText('tool');
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', 'Change project: tool · box');
  await expect(page.locator('button.host-ctx')).toHaveAttribute('aria-label', /^Run on: box, /);
});
