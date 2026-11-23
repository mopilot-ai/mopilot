// "Approve for me" on a machine chat follows the selected model like This Mac's menu (audit L40), in the real renderer against the fake `ssh` Host: a model that reports supportsAutoMode false disables the row ("This model can't auto-approve"), a model that reports true or says nothing (an older Host) leaves it enabled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform !== 'darwin', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-permission-automode-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const LEVELS = ['low', 'high'];
// one model per case: reports false, reports true, says nothing (the field absent, as an older Host)
const HARNESSES = [
  {
    id: 'claude',
    detected: true,
    signedIn: true,
    models: [
      { id: 'noauto', name: 'Alpha', default: true, efforts: LEVELS, defaultEffort: 'high', supportsAutoMode: false },
      { id: 'auto', name: 'Beta', default: false, efforts: LEVELS, defaultEffort: 'high', supportsAutoMode: true },
      { id: 'plain', name: 'Gamma', default: false, efforts: LEVELS, defaultEffort: 'high' },
    ],
  },
];
const NO_AUTO = "This model can't auto-approve";

// the new chat's Run on chip in the context bar
const chip = (page: Page) => page.locator('button.host-ctx');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });
const permission = (page: Page) => page.getByRole('button', { name: 'Change permissions' });
const autoRow = (page: Page) => page.locator('.perm-item.auto-review');

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

/** The machine chat's agent is Claude Code: open its models beside the harness list. */
async function openClaudeModels(page: Page) {
  await modelButton(page).click();
  const title = page.getByRole('button', { name: 'Select harness and model' });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: 'Claude Code' }).hover();
}

/** Pick a model by the name its row shows. */
async function pickModel(page: Page, name: RegExp) {
  await openClaudeModels(page);
  await page.getByRole('menuitemradio', { name }).click();
  await expect(modelButton(page).locator('.model-name')).toHaveText(name);
}

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, FAKE_HOST_HARNESSES: JSON.stringify(HARNESSES), PATH: withPath([FAKE_SSH_BIN]) },
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
            harnesses: HARNESSES,
            // read when the registry file is written, not when the worker loads this file (#3548)
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

test('Approve for me follows the selected machine model: off for false, on for true and for not reported', async ({ harness }) => {
  const page = harness.page;
  await pickMachineFolder(page);
  await expect(modelButton(page).locator('.model-name')).toHaveText('Alpha', { timeout: 45_000 });

  // the default model reports false: the row is disabled and says why, and a click changes nothing
  await permission(page).click();
  await expect(autoRow(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(autoRow(page)).toHaveAttribute('title', new RegExp(NO_AUTO));
  await shootBoth(page, harness.app, 'permission-auto-review-disabled');
  // the row is disabled as a choice, and a real click still tells the person why (Playwright refuses to click aria-disabled, so force it); the line is the toast's, the popover shows none
  await autoRow(page).click({ force: true });
  await expect(page.getByText(NO_AUTO).first()).toBeVisible();
  await expect(autoRow(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(permission(page)).toContainText('Ask for approval');

  // a model that reports true: enabled
  await pickModel(page, /^Beta/);
  await permission(page).click();
  await expect(autoRow(page)).not.toHaveAttribute('aria-disabled', 'true');
  await shootBoth(page, harness.app, 'permission-auto-review-enabled');
  await page.keyboard.press('Escape');

  // a model that says nothing: no gate, and the pick applies
  await pickModel(page, /^Gamma/);
  await permission(page).click();
  await expect(autoRow(page)).not.toHaveAttribute('aria-disabled', 'true');
  await autoRow(page).click();
  await expect(permission(page)).toContainText('Approve for me');

  // back to the model that reports false: the row is disabled again
  await pickModel(page, /^Alpha/);
  await permission(page).click();
  await expect(autoRow(page)).toHaveAttribute('aria-disabled', 'true');
});
