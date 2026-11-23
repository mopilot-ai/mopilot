// The context bar's Run on chip picks the machine a new chat runs on (#3367), in the real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh` and a resident fake Host (fixtures/fake-ssh/host-chats.cjs):
// pick the machine in My machines, its folder picker opens, the Run on chip names the machine and the project chip its folder, and the first message starts the chat there; the started chat's host chip names the machine and its machine rows are disabled, their tooltip says Switch host moves it;
// the top New chat starts on This Mac and This Mac drops the pick; the machine again comes back with the folder used there, also while it is away, and the first message waits for it.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { STANDALONE_NEW_CHAT_SELECTOR } from './fixtures/sidebar';
import { SYSTEM_THEME, shoot } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-chip-pick-')));
const FOLDER = path.join(ROOT, 'app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const HARNESSES = [{ id: 'kimi', detected: true, signedIn: true }];
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: HARNESSES,
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

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_OFFLINE: OFFLINE,
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_HARNESSES: JSON.stringify(HARNESSES),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
// the machine drops and comes back within the test
test.setTimeout(240_000);

// a new chat's Run on chip in the context bar; a started chat's host chip in the composer footer
const runOn = (page: Page) => page.locator('button.host-ctx');
const chip = (page: Page) => page.locator('button.host-chip');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
// a row's accessible name starts with its status dot ("Online box …"): find it by its title
const machineRow = (page: Page, name: string) =>
  menu(page)
    .getByRole('menuitemradio')
    .filter({ has: page.locator('.menu-title', { hasText: new RegExp(`^${name}$`) }) });
const folder = (page: Page) => page.locator('.ctxbar .ctx-btn').first();
const main = (page: Page) => page.getByRole('main');
const starts = () => (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).filter((c) => c.method === 'chat.start');

async function pick(page: Page, name: string) {
  await runOn(page).click();
  await machineRow(page, name).click();
  await expect(menu(page)).toHaveCount(0);
}

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await expect(composer).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('a machine picked in the Run on chip runs the new chat; a started chat keeps its machine; the machine comes back with its folder while away', async ({
  page,
}) => {
  // the machine answers once: its row is green and This Mac is checked
  await expect(runOn(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
  await expect(chip(page)).toHaveCount(0);
  await runOn(page).click();
  await expect(machineRow(page, 'box').locator('.host-dot')).toHaveClass(/online/, { timeout: 45_000 });
  await expect(machineRow(page, 'This Mac')).toHaveAttribute('aria-checked', 'true');
  await shoot(page, 'host-chip-pick-before');
  await page.keyboard.press('Escape');

  // picking the machine opens its folder picker (no folder was used there yet); the folder and the chip follow the pick
  await pick(page, 'box');
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(runOn(page)).toHaveAttribute('aria-label', 'Run on: box, online');
  await expect(runOn(page).locator('.host-name')).toHaveText('box');
  await expect(folder(page)).toHaveText('app');
  await expect(folder(page)).toHaveAttribute('aria-label', 'Change project: app · box');
  await runOn(page).click();
  await expect(machineRow(page, 'box')).toHaveAttribute('aria-checked', 'true');
  await expect(machineRow(page, 'This Mac')).toHaveAttribute('aria-checked', 'false');
  await shoot(page, 'host-chip-pick-after');
  await page.keyboard.press('Escape');

  // the first message starts the chat on the machine, in that folder, on the agent the machine has ready
  await send(page, 'hello box');
  await expect(main(page).getByText('fake-host: hello box', { exact: true })).toBeVisible({ timeout: 45_000 });
  expect(starts()[0]?.params).toMatchObject({ harness: 'acp:kimi', cwd: FOLDER });

  // the started chat's host chip is back in the composer footer and names the machine (the Run on chip is the new chat's)
  // its own row is checked and inert; This Mac's row opens Switch host with it picked (#3579)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(runOn(page)).toHaveCount(0);
  await expect(chip(page)).toHaveAttribute('aria-label', 'Host: box, online');
  await chip(page).click();
  await expect(page.locator('.host-menu .perm-mode-note')).toHaveCount(0);
  await expect(machineRow(page, 'box')).toHaveAttribute('aria-checked', 'true');
  await expect(machineRow(page, 'box')).toHaveAttribute('aria-disabled', 'true');
  const here = machineRow(page, 'This Mac');
  // the chat can switch once its host is known: until then the row only says why
  await expect(page.getByRole('menu', { name: 'My machines' }).getByRole('menuitem', { name: /Switch host/ })).not.toHaveAttribute(
    'aria-disabled',
    'true',
    { timeout: 45_000 },
  );
  await expect(here).not.toHaveAttribute('aria-disabled', 'true');
  await expect(here).not.toHaveAttribute('title');
  await shoot(page, 'host-chip-started-chat');
  await here.click();
  const switchHost = page.getByRole('dialog', { name: 'Switch host' });
  await expect(switchHost.getByRole('radio', { name: /This Mac/ })).toHaveAttribute('aria-checked', 'true', { timeout: 45_000 });
  await page.keyboard.press('Escape');
  await expect(switchHost).toHaveCount(0);
  await expect(chip(page)).toHaveAttribute('aria-label', 'Host: box, online');

  // New chat restores the last Run on device and the folder used there.
  await page.locator(STANDALONE_NEW_CHAT_SELECTOR).click();
  await expect(page.locator('.dialog')).toHaveCount(0);
  await expect(runOn(page)).toHaveAttribute('aria-label', 'Run on: box, online');
  await expect(folder(page)).toHaveText('app');
  await expect(folder(page)).toHaveAttribute('aria-label', 'Change project: app · box');
  // This Mac drops the pick
  await pick(page, 'This Mac');
  await expect(runOn(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online');
  await expect(folder(page)).not.toHaveAttribute('aria-label', /· box$/);

  // while the machine is away it can still be picked (its dot turns grey only at its next check): the folder used there comes back,
  // and the first message waits for it
  fs.writeFileSync(OFFLINE, '');
  await pick(page, 'box');
  await expect(page.locator('.dialog')).toHaveCount(0);
  await expect(runOn(page)).toHaveAttribute('aria-label', /^Run on: box, /);
  await expect(folder(page)).toHaveText('app');
  await expect(folder(page)).toHaveAttribute('aria-label', 'Change project: app · box');
  await send(page, 'while away');
  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 60_000 });
  await shoot(page, 'host-chip-pick-waiting');
  fs.rmSync(OFFLINE, { force: true });
  await expect(main(page).getByText('fake-host: while away', { exact: true })).toBeVisible({ timeout: 90_000 });
  expect(starts().map((c) => c.params.cwd)).toEqual([FOLDER, FOLDER]);
});
