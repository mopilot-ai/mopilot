// What the machine chat's model button shows is what the Host receives: for a Host older than the option fields (it lists Claude models with `efforts` but no option fields), the button reads the shared-rule effort (High, #5079) and the first message's `chat.start` carries that effort and the picked model (#5142 asserted the display only).
// Real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh` and the resident fake Host (fixtures/fake-ssh/host-chats.cjs), which answers chat.start for any agent and logs every request to FAKE_HOST_LOG.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform !== 'darwin', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'old-host-effort-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
// a unix socket path is short: the resident Host's lives in its own temp folder
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-')));
const SOCK = path.join(RESIDENT, 'h.sock');

// a Host older than the option fields: names and efforts only
const LEVELS = ['low', 'medium', 'high'];
const WITHOUT_FIELDS = [
  {
    id: 'claude',
    detected: true,
    signedIn: true,
    models: [
      { id: 'default', name: 'Default (recommended)', default: true, efforts: LEVELS, defaultEffort: null },
      { id: 'opus', name: 'Opus', default: false, efforts: LEVELS, defaultEffort: null },
    ],
  },
];

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

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_HARNESSES: JSON.stringify(WITHOUT_FIELDS),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: {
    uiState: SYSTEM_THEME,
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:me@box',
            name: 'box',
            address: 'me@box',
            socketPath: '/h/host.sock',
            capabilities: { shell: true },
            harnesses: WITHOUT_FIELDS,
            // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
            get lastHeartbeat() {
              return Date.now();
            },
            setup: '',
            hostKey: 'ab'.repeat(16),
          },
        ],
      },
    },
  },
});
test.setTimeout(240_000);

const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];
// the new chat's Run on chip in the context bar
const chip = (page: Page) => page.locator('button.host-ctx');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function pickMachineFolder(page: Page) {
  await expect(chip(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
  await chip(page).click();
  await menu(page)
    .getByRole('menuitemradio')
    .filter({ has: page.locator('.menu-title', { hasText: /^box$/ }) })
    .click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', /· box/, { timeout: 30_000 });
}

test('the effort the button shows for a Host without option fields is the effort the Host gets on start', async ({ harness }) => {
  const page = harness.page;
  await pickMachineFolder(page);
  const button = modelButton(page);
  await expect(button.locator('.model-name')).toHaveText('Default', { timeout: 45_000 });
  await expect(button.locator('.model-effort')).toHaveText('High');
  // pick Opus explicitly so the model on the wire is a pick, not the Default row; the effort stays the shared-rule one
  await button.click();
  const title = page.getByRole('button', { name: 'Select harness and model' });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: 'Claude Code' }).hover();
  await page.getByRole('menuitemradio', { name: /^Opus/ }).click();
  await expect(button.locator('.model-effort')).toHaveText('High');

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('which effort');
  await expect(composer).toHaveText('which effort');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-host: which effort', { exact: true })).toBeVisible({ timeout: 45_000 });

  // the display and the wire agree: the Host was told what the button showed (model Opus, effort High) for the folder the picker ends on, which is ROOT (the picker's own path text, as in host-agent-options), not ROOT/app
  const start = calls().find((c) => c.method === 'chat.start');
  expect(start?.params).toMatchObject({ harness: 'claude', cwd: ROOT, model: 'opus', effort: 'high' });
});
