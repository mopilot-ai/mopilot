// CUJ machine-default-mode (#5403): a chat on a machine starts in the user's default permission, as a chat on This Mac does, for Claude Code and Codex under each default (Ask for approval, Approve for me, Full access).
// What it asserts (the fake Host raises its card for "approve" whatever the mode, so a card count would not measure the mode): the chip of the new local chat and of the new machine chat read the same, and the machine chat's first chat.start carries that mode.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { connectSocket } from '../support/connectSocket';
import { test, expect } from './fixtures/app';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';
import { openHarnessList } from './fixtures/harnessPicker';
import { withPath } from './fixtures/nodeCommand';
import { SYSTEM_THEME } from './fixtures/shoot';
import { STANDALONE_NEW_CHAT_SELECTOR } from './fixtures/sidebar';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuj-machine-mode-')));
fs.mkdirSync(path.join(ROOT, 'app', '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const AGENTS = ['claude', 'codex'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [{ id: `${id}-remote-default`, name: `${id} Remote default`, default: true, efforts: ['low'], defaultEffort: 'low' }],
}));
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: AGENTS,
  // read when the registry file is written, not when the worker loads this file (#3548)
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
test.beforeEach(() => fs.rmSync(LOG, { force: true }));
test.setTimeout(240_000);

const DEFAULTS = [
  { mode: 'default', label: 'Ask for approval' },
  { mode: 'auto-review', label: 'Approve for me' },
  { mode: 'full-access', label: 'Full access' },
] as const;
const FAMILIES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
] as const;

const perm = (page: Page) => page.getByRole('button', { name: 'Change permissions' });
const starts = () => (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).filter((c) => c.method === 'chat.start');

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await expect(composer).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The new chat's agent on This Mac: the family's row in the harness list, its recommended model. */
async function pickLocal(page: Page, name: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: name }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Default (recommended)' }).click();
}

/** The Run on chip's machine and its folder, then the family's agent the machine reports. */
async function pickMachine(page: Page, id: string, name: string) {
  await expect(page.locator('button.host-ctx')).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
  await page.locator('button.host-ctx').click();
  await page
    .getByRole('menu', { name: 'My machines' })
    .getByRole('menuitemradio')
    .filter({ has: page.locator('.menu-title', { hasText: /^box$/ }) })
    .click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', /· box/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Select model', exact: true }).click();
  const title = page.getByRole('button', { name: 'Select harness and model', exact: true });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: name }).hover();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${id} Remote default`) }).click();
  await page.keyboard.press('Escape');
}

for (const { mode, label } of DEFAULTS) {
  test.describe(`the user's default is ${label}`, () => {
    test.use({
      harnesses: 'both',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_LOG: LOG,
        FAKE_HOST_CHATS_SOCK: SOCK,
        FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: {
        uiState: { ...SYSTEM_THEME, prefs: { permission: mode } },
        userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } },
      },
    });

    for (const { id, name } of FAMILIES) {
      test(`${name}: a chat on the machine starts in ${label}, as a chat on This Mac does`, async ({ page }) => {
        // This Mac: the new chat's chip is the user's default
        await pickLocal(page, name);
        await expect(perm(page)).toContainText(label);
        const local = (await perm(page).innerText()).trim();

        // the machine: a new chat there reads the same, and its first message hands the Host that mode
        await page.locator(STANDALONE_NEW_CHAT_SELECTOR).click();
        await pickMachine(page, id, name);
        await expect(perm(page)).toContainText(label);
        expect((await perm(page).innerText()).trim()).toBe(local);
        await send(page, 'hello box');
        await expect(page.getByRole('main').getByText('fake-host: hello box', { exact: true })).toBeVisible({ timeout: 45_000 });
        expect(starts()[0]?.params).toMatchObject({ permission: mode });
        // started, the chat's chip still reads the default
        await expect(perm(page)).toContainText(label);
      });
    }
  });
}
