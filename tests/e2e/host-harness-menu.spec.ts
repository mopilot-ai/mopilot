// A machine chat's Harness menu in the real renderer (#5072), against the fake `ssh` that serves the Host protocol (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1): every row says its state once (badge, then a cause or a hint, then the action) and none is a dead end.
// One app launch per machine state (the fake Host serves one state to every machine): a missing agent the Host installs (badge, hint, Install on box), one a Host too old to install (Update), one that cannot and is current (the vendor's command, Copy, Check again, Open terminal);
// signed-out agents with and without a cause (the second line only with a cause); and the effort of a new chat on a Host that reports no default effort, a level and never the word Default. Each surface is shot in light and dark, and its visible text asserted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// the pictures are of the Mac app's own type and spacing
test.skip(process.platform !== 'darwin', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-harness-menu-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// what the Host's Claude catalog sends: no default effort
const CLAUDE_MODELS = [
  {
    id: 'default',
    name: 'Default (recommended)',
    default: true,
    efforts: LEVELS,
    defaultEffort: null,
    description: 'Use the default model (currently Opus 5.5) · Best for complex work',
  },
  { id: 'opus', name: 'Opus', default: false, efforts: LEVELS, defaultEffort: null, description: 'Opus 5.5 · Best for complex work' },
];
const claude = { id: 'claude', detected: true, signedIn: true, models: CLAUDE_MODELS };
const missing = (id: string, over: object = {}) => ({ id, detected: false, signedIn: false, ...over });

const AGENTS = {
  // the Host installs Codex itself
  installable: [claude, missing('codex', { installable: true })],
  // a Host that cannot install Codex (it reports none installable) and is current: the vendor's own command is the fix. The picker lists a missing agent only for Claude Code and Codex (shownAgents), so Codex is the agent here
  byhand: [claude, missing('codex')],
  // a Host older than the app cannot install Codex: the row's fix is the machine's own Update
  older: [claude, missing('codex')],
  // installed but signed out: with a cause the Host knows, with named sign-in methods, and with neither
  signedout: [
    { id: 'claude', detected: true, signedIn: false, reason: 'keychain-locked' },
    { id: 'codex', detected: true, signedIn: false, signIn: ['Google account'] },
    { id: 'gemini', detected: true, signedIn: false },
  ],
  effort: [claude],
};

const record = (agents: object[]) => ({
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: agents,
  // read when the registry file is written, not when the worker loads this file (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
  hostKey: 'ab'.repeat(16),
});

// the new chat's Run on chip in the context bar
const chip = (page: Page) => page.locator('button.host-ctx');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });
const row = (page: Page, label: string) => page.locator('.hp-row', { hasText: label });

async function pickMachineFolder(page: Page) {
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

/** The machine chat's harness list: the picker opens on the model, its title opens the list (it opens on the list when no agent is usable). */
async function openHarnessList(page: Page) {
  await modelButton(page).click();
  const title = page.getByRole('button', { name: 'Select harness and model' });
  if (await title.count()) await title.click();
  await expect(page.locator('.hp-row').first()).toBeVisible({ timeout: 45_000 });
}

/** One machine state per launch; its registry seed is a literal at the call (tests/hostFixtureHeartbeat.invariant.test.ts evaluates seeds from top-level names only). */
function describeMachine(
  name: keyof typeof AGENTS,
  seed: { userData: object },
  check: (page: Page, shoot: (shot: string) => Promise<void>) => Promise<void>,
  build?: string,
) {
  test.describe(`machine: ${name}`, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_HARNESSES: JSON.stringify(AGENTS[name]),
        ...(build ? { FAKE_HOST_BUILD: build } : {}),
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: { uiState: SYSTEM_THEME, ...seed },
    });
    test.setTimeout(240_000);

    test(`the Harness menu says each row once and offers its fix (${name})`, async ({ harness }) => {
      const page = harness.page;
      await expect(chip(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
      await pickMachineFolder(page);
      await check(page, (shot) => shootBoth(page, harness.app, `host-harness-menu-${name}-${shot}`));
    });
  });
}

describeMachine(
  'installable',
  { userData: { 'host-registry.json': { version: 1, hosts: [record(AGENTS.installable)] } } },
  async (page, shoot) => {
    await openHarnessList(page);
    const codex = row(page, 'Codex');
    // the badge, the hint the local row uses (worded for the machine), and the action: not "Not installed on box"
    await expect(codex.locator('.hp-badge')).toHaveText('Not installed');
    await expect(codex.locator('.menu-desc')).toHaveText('Install Codex on box.');
    await expect(codex.getByRole('menuitem', { name: 'Install on box' })).toBeVisible();
    await expect(page.getByText('Not installed on box')).toHaveCount(0);
    await expect(codex.locator('.install-by-hand')).toHaveCount(0);
    await shoot('list');
  },
);

describeMachine(
  'older',
  { userData: { 'host-registry.json': { version: 1, hosts: [record(AGENTS.older)] } } },
  async (page, shoot) => {
    await openHarnessList(page);
    const codex = row(page, 'Codex');
    await expect(codex.locator('.hp-badge')).toHaveText('Not installed');
    await expect(codex.locator('.menu-desc').first()).toHaveText('Install Codex on box.');
    // a Host too old to install: the machine row's own Update, not a row with nothing to press
    await expect(codex.getByRole('button', { name: 'Update the Host on box' })).toBeVisible({ timeout: 45_000 });
    await expect(codex.getByRole('menuitem', { name: 'Install on box' })).toHaveCount(0);
    await expect(codex.locator('.install-by-hand')).toHaveCount(0);
    await shoot('list');
  },
  'an-older-build',
);

describeMachine('byhand', { userData: { 'host-registry.json': { version: 1, hosts: [record(AGENTS.byhand)] } } }, async (page, shoot) => {
  await openHarnessList(page);
  const codexRow = row(page, 'Codex');
  await expect(codexRow.locator('.hp-badge')).toHaveText('Not installed');
  await expect(codexRow.locator('.menu-desc').first()).toHaveText('Install Codex on box.');
  // the Host cannot install it and is current: the vendor's own command, Copy and Check again, and a terminal on the machine
  await expect(codexRow.locator('code.install-cmd')).toHaveText('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  await expect(codexRow.getByRole('button', { name: 'Copy the Codex command' })).toBeVisible();
  await expect(codexRow.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(codexRow.getByRole('menuitem', { name: 'Open terminal' })).toBeVisible();
  await expect(codexRow.getByRole('menuitem', { name: /^Install on/ })).toHaveCount(0);
  await expect(page.getByText('Not installed on box')).toHaveCount(0);
  await shoot('list');
  // the command wraps inside the row: the menu does not scroll sideways and the command stays inside it
  const fit = await page.locator('.hp-harnesses').evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    const cmd = menu.querySelector('code.install-cmd')!.getBoundingClientRect();
    const scrolls = [menu, ...menu.querySelectorAll('*')].filter(
      (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible',
    );
    return {
      wide: menu.scrollWidth > menu.clientWidth + 1,
      inside: cmd.right <= box.right + 0.5 && cmd.left >= box.left - 0.5,
      clipped: scrolls.length,
    };
  });
  expect(fit).toEqual({ wide: false, inside: true, clipped: 0 });
  // the actions work from inside the row (its choice is disabled, they are not): Copy says it copied, Check again asks the Host and comes back,
  // Open terminal closes the menu and opens the bottom terminal panel with a shell tab titled with the machine's name (an ssh shell in the chat's folder there)
  await codexRow.getByRole('button', { name: 'Copy the Codex command' }).click();
  await expect(codexRow.getByRole('button', { name: 'Copied' })).toBeVisible();
  await codexRow.getByRole('button', { name: 'Check again' }).click();
  await expect(codexRow.getByRole('button', { name: 'Check again' })).toBeEnabled({ timeout: 30_000 });
  await codexRow.getByRole('menuitem', { name: 'Open terminal' }).click();
  await expect(page.locator('.hp-harnesses')).toHaveCount(0);
  // from the new-chat screen the machine is the draft's pick (the context bar's Run on chip), so the shell is ssh to it, not a local one titled with a folder
  const tab = page.locator('.bottom-panel .bottom-tab');
  await expect(tab).toHaveCount(1, { timeout: 30_000 });
  await expect(tab.first()).toHaveAttribute('aria-label', /^box( \(exited\))?$/);
  await expect(tab.first()).not.toContainText('home');
  // an ssh to the machine's own target, never a local shell (the fake-ssh fixture cannot resolve the host, so the shell exits; a live one is covered by host-machine-terminal.spec.ts)
  await expect(page.locator('.bottom-panel .xterm-rows')).toContainText('hostname box', { timeout: 30_000 });
});

describeMachine(
  'signedout',
  { userData: { 'host-registry.json': { version: 1, hosts: [record(AGENTS.signedout)] } } },
  async (page, shoot) => {
    // no agent is usable: the picker opens on its list
    await openHarnessList(page);
    for (const label of ['Claude Code', 'Codex', 'Gemini']) {
      await expect(row(page, label).locator('.hp-badge').filter({ hasText: 'Signed out' })).toHaveCount(1);
      await expect(row(page, label).getByRole('menuitem', { name: `Sign in to ${label}` })).toBeVisible();
    }
    // a second line only with a cause: a locked keychain, the sign-in method the agent names; none for a plain signed-out agent
    await expect(row(page, 'Claude Code').locator('.menu-desc')).toHaveText(
      "box's keychain is locked. Log in on its screen once, or sign in again.",
    );
    await expect(row(page, 'Codex').locator('.menu-desc')).toHaveText('Sign in on box: Google account');
    await expect(row(page, 'Gemini').locator('.menu-desc')).toHaveCount(0);
    await expect(row(page, 'Gemini')).not.toContainText('Sign in on box');
    await shoot('list');
  },
);

describeMachine('effort', { userData: { 'host-registry.json': { version: 1, hosts: [record(AGENTS.effort)] } } }, async (page, shoot) => {
  const button = modelButton(page);
  await expect(button.locator('.model-name')).toHaveText('Opus 5.5', { timeout: 45_000 });
  // the Host reports no default effort: a level, the one This Mac's picker would show, never the word Default
  await expect(button.locator('.model-effort')).toHaveText('High');
  await button.click();
  await expect(page.locator('.effort-name')).toHaveText('High');
  await expect(page.locator('.effort-knob')).toHaveCount(1);
  await shoot('effort');
});
