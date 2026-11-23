// A machine with one agent ready and others installed but signed out (#4931, the owner's Mac mini: Claude Code ready, Gemini and Grok installed), in the real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh`:
// the machine's row in Settings names each agent that needs sign-in beside the one that runs, its Sign in starts that agent's sign-in on the Host, and the composer's harness list shows the same agents with their own Sign in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';
import { shoot } from './fixtures/shoot';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-signed-out-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const HARNESSES = [
  { id: 'claude', detected: true, signedIn: true },
  { id: 'gemini', detected: true, signedIn: false },
  { id: 'grok', detected: true, signedIn: false },
];
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.use({
  harnesses: 'codex',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_HARNESSES: JSON.stringify(HARNESSES),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: {
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
          },
        ],
      },
    },
  },
});
test.setTimeout(180_000);

const logins = () => (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).filter((c) => c.method === 'host.login');

async function pickFolderOn(page: Page, name: string) {
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText(`Folder on ${name}…`).click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // the project chip names only the folder; its label still says the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', new RegExp(` · ${name}$`));
}

test('the row names the agents that need sign-in beside the one that runs, and both it and the harness list sign them in', async ({
  page,
}) => {
  // Settings: the machine's row
  await openConnections(page);
  const mine = page.getByRole('region', { name: 'Machines' });
  await expect(mine.locator('.machine-status')).toHaveText('Online · Claude Code · Gemini and Grok need sign-in', { timeout: 45_000 });
  await expect(mine.locator('.machine-dot')).toHaveClass(/\bok\b/);
  await shoot(page, 'signed-out-agents-row');
  await mine.getByRole('button', { name: 'Sign in to Gemini on box' }).click();
  await expect.poll(() => logins().map((c) => c.params.harness), { timeout: 30_000 }).toContain('gemini');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // the composer: a new chat on the machine lists the same agents, each with its Sign in
  await pickFolderOn(page, 'box');
  // a machine that reports no models opens the picker on its harness list
  await page.getByRole('button', { name: 'Select model' }).click();
  const list = page.locator('.hp-harnesses');
  await expect(list.locator('.hp-row', { hasText: 'Grok' })).toContainText('Signed out');
  await shoot(page, 'signed-out-agents-picker');
  await list.getByRole('menuitem', { name: 'Sign in to Grok' }).click();
  await expect.poll(() => logins().map((c) => c.params.harness), { timeout: 30_000 }).toContain('grok');
});
