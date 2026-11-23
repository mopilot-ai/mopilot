// A new chat in a folder on a machine is offered the agents that machine can run, by its own readiness, in the real renderer (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh` that serves the Host protocol: this Mac has no Claude Code login, yet the machine whose Claude Code is signed in offers it (the signed-out machine and the sign-in action are covered by tests/hostAgentPicker.test.ts: the fake Host serves one state to every machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-e2e-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });

const machine = (name: string, harnesses: { id: string; detected: boolean; signedIn: boolean }[]) => ({
  id: `ssh:me@${name}`,
  name,
  address: `me@${name}`,
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses,
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
});

test.use({
  // this Mac: Codex only, Claude Code signed out
  harnesses: 'codex',
  shellPath: [FAKE_SSH_BIN],
  env: { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, PATH: withPath([FAKE_SSH_BIN]) },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [machine('box', [{ id: 'claude', detected: true, signedIn: true }])],
      },
    },
  },
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function pickFolderOn(page: Page, name: string) {
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText(`Folder on ${name}…`).click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // the project chip names only the folder; its label still says the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', new RegExp(` · ${name}$`));
}

test('this Mac has no Claude login: the machine with Claude Code ready offers it', async ({ page }) => {
  await pickFolderOn(page, 'box');
  // a machine that reports no models: the model button names the agent, and its list offers that agent's default
  const agent = page.getByRole('button', { name: 'Select model' });
  await expect(agent).toHaveText('Claude Code');
  await agent.click();
  await expect(page.getByRole('menuitemradio', { name: 'Use Claude Code default' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  // the saved default here is Codex, which box lacks: the note says so, and never that Claude Code isn't signed in (that was this Mac)
  // (the note also carries the vendor's install command, Docs and Check again for an agent the Host cannot install: InstallByHand)
  await expect(page.locator('[data-host-agent-note]')).toContainText('Codex: Not installed on box; new chats start in Claude Code');
});
