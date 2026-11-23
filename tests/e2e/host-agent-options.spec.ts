// A machine chat's model picker reads the option fields a Host sends (#4935), in the real renderer (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh` that serves the Host protocol: with the fields every model is named by the model it resolves to, the Default row names its target,
// the default effort is the Host's, and no speed toggle is offered (deferred until the Host send path takes it); from a Host older than the fields the picker keeps today's honest line ("Model not reported") and no toggle. One app launch per Host state (the fake Host serves one state to every machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

test.skip(process.platform !== 'darwin', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-options-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const LEVELS = ['low', 'medium', 'high'];
// a Host that sends the option fields
const WITH_FIELDS = [
  {
    id: 'claude',
    detected: true,
    signedIn: true,
    models: [
      {
        id: 'default',
        name: 'Default (recommended)',
        default: true,
        efforts: LEVELS,
        defaultEffort: 'high',
        resolvedModel: 'Opus 5.5',
        resolvedId: 'claude-opus-5-5',
        supportsFastMode: true,
      },
      {
        id: 'opus',
        name: 'Opus',
        default: false,
        efforts: LEVELS,
        defaultEffort: 'high',
        resolvedModel: 'Opus 5.5',
        resolvedId: 'claude-opus-5-5',
        supportsFastMode: true,
      },
      {
        id: 'haiku',
        name: 'Haiku',
        default: false,
        efforts: LEVELS,
        defaultEffort: 'low',
        resolvedModel: 'Haiku 4.5',
        supportsFastMode: false,
      },
    ],
  },
];
// a Host older than the fields: names and efforts only
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

/** The machine chat's agent is Claude Code: open its models beside the harness list. */
async function openClaudeModels(page: Page) {
  await modelButton(page).click();
  const title = page.getByRole('button', { name: 'Select harness and model' });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: 'Claude Code' }).hover();
}

test.describe('a Host that sends the option fields', () => {
  test.use({
    harnesses: 'claude',
    shellPath: [FAKE_SSH_BIN],
    env: { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, FAKE_HOST_HARNESSES: JSON.stringify(WITH_FIELDS), PATH: withPath([FAKE_SSH_BIN]) },
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
              harnesses: WITH_FIELDS,
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

  test('models are named by what they resolve to, and Default names its target and effort', async ({ harness }) => {
    const page = harness.page;
    await pickMachineFolder(page);
    const button = modelButton(page);
    // the chip: the model Default resolves to, at the Host's default effort
    await expect(button.locator('.model-name')).toHaveText('Opus 5.5', { timeout: 45_000 });
    await expect(button.locator('.model-effort')).toHaveText(/high/i);
    await openClaudeModels(page);
    await expect(page.getByRole('menuitemradio', { name: /^Opus 5\.5/ })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: /^Haiku 4\.5/ })).toBeVisible();
    await expect(page.getByText('Model not reported')).toHaveCount(0);
    // the Host reports fast mode, but no control is offered until the Host's send path takes it (deferred)
    await page.getByRole('menuitemradio', { name: /^Opus 5\.5/ }).click();
    await button.click();
    await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openClaudeModels(page);
    await page.getByRole('menuitemradio', { name: /^Haiku 4\.5/ }).click();
    await expect(button.locator('.model-name')).toHaveText('Haiku 4.5');
  });
});

test.describe('a Host older than the option fields', () => {
  test.use({
    harnesses: 'claude',
    shellPath: [FAKE_SSH_BIN],
    env: {
      MOPILOT_HOST_DEV: '1',
      FAKE_HOST_ROOT: ROOT,
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

  test('the picker keeps the honest line, shows the shared-rule effort and offers no speed toggle', async ({ harness }) => {
    const page = harness.page;
    await pickMachineFolder(page);
    const button = modelButton(page);
    await expect(button.locator('.model-name')).toHaveText('Default', { timeout: 45_000 });
    // a Host that reports no default effort gets the one a local new chat shows (the shared defaultEffort rule: High), never the word "Default" (#5079); the model itself is still not reported
    await expect(button.locator('.model-effort')).toHaveText('High');
    await openClaudeModels(page);
    await expect(page.getByText('Model not reported by box')).toBeVisible();
    await page.keyboard.press('Escape');
    await button.click();
    await expect(page.getByRole('button', { name: 'Toggle fast mode' })).toHaveCount(0);
  });
});
