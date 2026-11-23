// An agent a machine lacks and its Host cannot install (Cursor: the catalog has no npm line) says so in the new-chat note and offers the vendor's own command with Copy and Check again, in the real renderer (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh` that serves the Host protocol and a fake Cursor agent on this Mac.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-by-hand-e2e-')));
fs.mkdirSync(path.join(ROOT, 'app/.git'), { recursive: true });

const BOX = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  // read when the registry file is written, not when the worker loads this file (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

test.use({
  harnesses: 'claude',
  acp: { cursor: {} },
  shellPath: [FAKE_SSH_BIN],
  env: { MOPILOT_HOST_DEV: '1', FAKE_HOST_ROOT: ROOT, PATH: withPath([FAKE_SSH_BIN]) },
  seed: {
    uiState: { prefs: { defaultHarness: 'acp:cursor' } },
    userData: { 'host-registry.json': { version: 1, hosts: [BOX] } },
  },
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('Cursor is not on the machine and its Host cannot install it: the note offers the vendor command to copy and Check again', async ({
  page,
}) => {
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  const note = page.locator('[data-host-agent-note]');
  await expect(note).toContainText('Cursor: Not installed on box', { timeout: 45_000 });
  await expect(note.locator('code.install-cmd')).toHaveText('curl https://cursor.com/install -fsS | bash');
  await expect(note.getByRole('button', { name: /^Install on/ })).toHaveCount(0);
  await note.getByRole('button', { name: 'Copy the Cursor command' }).click();
  await expect(note.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(note.getByRole('button', { name: 'Check again' })).toBeEnabled();
});
