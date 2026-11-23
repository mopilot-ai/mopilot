// A machine chat's model picker in the real renderer (#4907), against the fake `ssh` that serves the Host protocol (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1): the same two-level picker as This Mac's, fed by the machine.
// One app launch per machine state (the fake Host serves one state to every machine): the chip is the agent's mark, the model with its version and the effort; the head holds one line; the first level lists the machine's agents with their state, usage and
// account; the models beside an agent carry their versions and the default is the model it is; an agent the machine lacks is a not-set-up row. Each surface is shot in light and dark, beside This Mac's, wide and narrow, and with the machine away.
// e2e-covers: src/components/composer/HostModelPicker.tsx src/components/composer/HostPickerSignin.tsx
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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-picker-layout-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
const OFFLINE = path.join(ROOT, 'offline');
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// what the Host's Claude catalog sends: the CLI's names, the version in the description, no default effort
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
  { id: 'fable', name: 'Fable', default: false, efforts: LEVELS, defaultEffort: null, description: 'Fable 5.2 · Creative and fast' },
  { id: 'sonnet', name: 'Sonnet', default: false, efforts: LEVELS, defaultEffort: null, description: 'Sonnet 5.5 · Everyday tasks' },
  { id: 'haiku', name: 'Haiku', default: false, efforts: LEVELS.slice(0, 3), defaultEffort: null, description: 'Haiku 5.5 · Fastest' },
  { id: 'claude-opus-4-1', name: 'Opus 4.1', default: false, efforts: LEVELS, defaultEffort: null, description: 'Older version' },
];
const CODEX_MODELS = [
  { id: 'gpt-5.6', name: 'GPT-5.6', default: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', default: false, efforts: ['low', 'medium'], defaultEffort: 'low' },
];
const LOGIN = {
  id: 'default',
  label: 'dev@mopilot.ai',
  state: 'ok',
  limited: false,
  billing: 'subscription',
  active: true,
  usage: [{ label: '5h', usedPercent: 84, resetsAt: null }],
};
const claude = (over: object = {}) => ({ id: 'claude', detected: true, signedIn: true, models: CLAUDE_MODELS, logins: [LOGIN], ...over });
const codex = { id: 'codex', detected: true, signedIn: true, models: CODEX_MODELS };
// signed out with no cause the Host knows: the badge and the Sign in button say all of it (a cause or named methods add a line: host-harness-menu.spec.ts)
const signedOut = (id: string) => ({ id, detected: true, signedIn: false });
const missing = (id: string) => ({ id, detected: false, signedIn: false });

const STATES: Record<string, { agents: object[] }> = {
  // the owner's machine: Claude Code ready on one account, Codex ready, others not there
  several: { agents: [claude(), codex, missing('antigravity'), missing('opencode'), missing('kimi')] },
  one: { agents: [claude()] },
  // installed but signed out: a row each, with its badge and a Sign in button
  signedout: { agents: [signedOut('claude'), signedOut('codex'), missing('kimi')] },
  // the login on the machine is expired: the row and the account say so
  expired: { agents: [claude({ logins: [{ ...LOGIN, state: 'expired', usage: undefined }] }), codex] },
  // the machine still offers models, but the account beside them needs to sign in again
  lapsed: { agents: [claude({ logins: [{ ...LOGIN, state: 'signedOut', usage: undefined }] }), codex] },
};

const record = (agents: object[]) => ({
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: agents,
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
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

/** The chat starts on the agent the machine has ready first (Codex here): pick Claude Code's default model, as a person would. */
async function chooseClaude(page: Page) {
  const button = modelButton(page);
  await button.click();
  const title = page.getByRole('button', { name: 'Select harness and model' });
  if (await title.count()) await title.click();
  await page.locator('.hp-row', { hasText: 'Claude Code' }).hover();
  await page.getByRole('menuitemradio', { name: /^Opus 5\.5/ }).click();
  await expect(button.locator('.model-name')).toHaveText('Opus 5.5');
  await page.keyboard.press('Escape');
}

/** The head's model line is one line: as tall as its own line height, and never wider than its box. */
async function expectOneLine(page: Page) {
  const { height, lineHeight, overflowing } = await page.locator('.effort-model-text').evaluate((el) => {
    const css = getComputedStyle(el);
    const pop = el.closest('.effort-pop')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      height: box.height,
      lineHeight: parseFloat(css.lineHeight) || 16,
      overflowing: box.right > pop.right + 0.5 || box.left < pop.left - 0.5,
    };
  });
  expect(height).toBeLessThanOrEqual(lineHeight * 1.2);
  expect(overflowing).toBe(false);
}

/** One machine state per launch; its registry seed is a literal at the call (tests/hostFixtureHeartbeat.invariant.test.ts evaluates seeds from top-level names only). */
function describeMachine(name: string, state: { agents: object[] }, seed: { userData: object }) {
  test.describe(`machine with ${name} agents`, () => {
    test.use({
      harnesses: 'claude',
      shellPath: [FAKE_SSH_BIN],
      env: {
        MOPILOT_HOST_DEV: '1',
        FAKE_HOST_ROOT: ROOT,
        FAKE_HOST_OFFLINE: OFFLINE,
        FAKE_HOST_HARNESSES: JSON.stringify(state.agents),
        FAKE_HOST_LOGIN_CODE: 'TEST-1234',
        PATH: withPath([FAKE_SSH_BIN]),
      },
      seed: { uiState: SYSTEM_THEME, ...seed },
    });
    test.setTimeout(240_000);

    test(`the machine's picker is This Mac's: chip, one-line head, agents with state, models with versions (${name})`, async ({
      harness,
    }) => {
      const page = harness.page;
      // This Mac's picker first, for the picture to set beside the machine's
      await expect(chip(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 45_000 });
      await modelButton(page).click();
      await shootBoth(page, harness.app, `host-model-picker-${name}-this-mac`);
      // its harness list, which opens with the models of the current harness beside it
      await page.getByRole('button', { name: 'Select harness and model' }).click();
      await expect(page.locator('.hp-row').first()).toBeVisible();
      await shootBoth(page, harness.app, `host-model-picker-${name}-this-mac-list`);
      await page.keyboard.press('Escape');
      const thisMacChip = await modelButton(page).innerText();

      await pickMachineFolder(page);
      const button = modelButton(page);
      if (name === 'signedout') {
        // no agent is usable: the picker opens on its list, every agent a row that says why
        await button.click();
        await expect(page.locator('.hp-row[data-disabled]')).toHaveCount(2);
        // said once: the badge and the button, no second line that only repeats them
        await expect(page.locator('.hp-row .hp-badge').filter({ hasText: 'Signed out' })).toHaveCount(2);
        await expect(page.getByRole('menuitem', { name: /^Sign in to / })).toHaveCount(2);
        await expect(page.getByText('Sign in on box')).toHaveCount(0);
        await shootBoth(page, harness.app, `host-model-picker-${name}-list`);
        return;
      }
      // the chip: the mark, the model with its version, the effort
      await expect(button.locator('.harness-icon').first()).toBeVisible({ timeout: 45_000 });
      if (name === 'lapsed') {
        await page.setViewportSize({ width: 1024, height: 682 });
        const list = async () => {
          await button.click();
          await page.getByRole('button', { name: 'Select harness and model' }).click();
        };
        await list();
        await page.locator('.hp-row', { hasText: 'Codex' }).click();
        await page
          .getByRole('menuitemradio', { name: /^GPT-5\.6\b/ })
          .first()
          .click();
        await expect(button.locator('.model-name')).toHaveText('GPT-5.6');
        await page.keyboard.press('Escape');
        await list();
        await page.locator('.hp-row', { hasText: 'Claude Code' }).click();
        await expect(page.locator('[data-account=default] .acct-status')).toHaveText('Subscription · Signed out');
        await page.getByRole('menuitem', { name: 'Sign in again to Claude Code' }).click();
        const progress = page.locator('.dialog', { hasText: 'Sign in to Claude Code on box' });
        await expect(progress.locator('.host-signin-code')).toHaveText('TEST-1234');
        await expect(progress.getByRole('button', { name: /Cancel signing in to Claude Code/ })).toBeEnabled();
        await expect(button.locator('.model-name')).toHaveText('GPT-5.6');
        await shootBoth(page, harness.app, 'host-model-picker-sign-in-again');
        return;
      }
      if (name === 'expired') {
        await chooseClaude(page);
        await button.click();
        await expectOneLine(page);
        await expect(page.getByRole('button', { name: 'Account: dev@mopilot.ai' })).toBeVisible();
        await shootBoth(page, harness.app, `host-model-picker-${name}-effort`);
        await page.getByRole('button', { name: 'Select harness and model' }).click();
        await expect(page.locator('[data-account] .acct-status')).toHaveText('Subscription · Expired');
        // the agent's own row says it too, in the warning tone
        await expect(page.locator('.hp-row', { hasText: 'Claude Code' }).locator('.menu-desc.warn')).toHaveText('dev@mopilot.ai · Expired');
        await shootBoth(page, harness.app, `host-model-picker-${name}-list`);
        return;
      }
      if (name === 'several') await chooseClaude(page);
      await expect(button.locator('.model-name')).toHaveText('Opus 5.5');
      // the Host reports no default effort: the chip reads the level This Mac's picker would (High), never the word Default
      await expect(button.locator('.model-effort')).toHaveText('High');
      expect(thisMacChip).not.toBe('');
      await button.click();
      await expectOneLine(page);
      await expect(page.locator('.effort-name')).toHaveText('High');
      await expect(page.locator('.effort-knob')).toHaveCount(1);
      await expect(page.getByText(/Runs on box/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Account: dev@mopilot.ai' })).toBeVisible();
      await shootBoth(page, harness.app, `host-model-picker-${name}-effort`);
      await page.locator('.effort-pop').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.effort-name')).toHaveText('Extra high');
      await expect(button.locator('.model-effort')).toHaveText('Extra high');
      await expect(page.locator('.effort-knob')).toHaveCount(1);

      // the first level: each agent with its mark and line, and the models of the agent beside it
      await page.getByRole('button', { name: 'Select harness and model' }).click();
      await expect(page.locator('.hp-row .hp-title').first()).toHaveText(/Claude Code/);
      await expect(page.locator('.hp-row', { hasText: 'Claude Code' }).locator('.menu-desc').first()).toHaveText(
        'dev@mopilot.ai · 16% left',
      );
      await expect(page.getByRole('menuitemradio', { name: /^Opus 5\.5/ })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('menuitemradio', { name: /^Fable 5\.2/ })).toBeVisible();
      await expect(page.getByRole('menuitemradio', { name: /^Sonnet 5\.5/ })).toBeVisible();
      await expect(page.getByText('Default (recommended)')).toHaveCount(0);
      await shootBoth(page, harness.app, `host-model-picker-${name}-list`);

      // another agent's models beside its row
      if (name === 'several') {
        await page.locator('.hp-row', { hasText: 'Codex' }).hover();
        await expect(page.getByRole('menuitemradio', { name: 'GPT-5.6 Luna' })).toBeVisible();
        await shootBoth(page, harness.app, `host-model-picker-${name}-codex`);
      }

      // a narrow window: the head still holds one line inside the popover
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 520, height: 640 });
      await button.click();
      await expect(page.locator('.effort-model-text')).toBeVisible();
      await expectOneLine(page);
      await shootBoth(page, harness.app, `host-model-picker-${name}-narrow`);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1280, height: 800 });

      // the machine away: the picker still shows what it last reported
      if (name === 'several') {
        fs.writeFileSync(OFFLINE, '');
        await button.click();
        await expect(page.locator('.effort-pop, .hp-harnesses').first()).toBeVisible();
        await shootBoth(page, harness.app, `host-model-picker-${name}-away`);
        fs.rmSync(OFFLINE, { force: true });
      }
    });
  });
}

describeMachine('several', STATES.several, { userData: { 'host-registry.json': { version: 1, hosts: [record(STATES.several.agents)] } } });
describeMachine('one', STATES.one, { userData: { 'host-registry.json': { version: 1, hosts: [record(STATES.one.agents)] } } });
describeMachine('signedout', STATES.signedout, {
  userData: { 'host-registry.json': { version: 1, hosts: [record(STATES.signedout.agents)] } },
});
describeMachine('expired', STATES.expired, { userData: { 'host-registry.json': { version: 1, hosts: [record(STATES.expired.agents)] } } });
describeMachine('lapsed', STATES.lapsed, { userData: { 'host-registry.json': { version: 1, hosts: [record(STATES.lapsed.agents)] } } });
