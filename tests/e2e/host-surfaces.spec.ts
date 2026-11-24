// The Host surfaces that need machines in different states, in dark and light for the visual review: the Run on chip's menu (a picker: one line per machine, no sign-in row), and Settings › Machines with an online machine whose agents are signed out (one status line and one Sign in, the next sign-in in its ⋯ menu), a second machine that is offline (a long name, seen 2 h ago), the How machines sign in sheet (keys, organization with More) and the Add machine sheet's three tabs. A test agent the machine reports is never named.
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { openConnections } from './fixtures/settings';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-surfaces-e2e-')));

const BOX = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [
    { id: 'claude', detected: true, signedIn: false },
    { id: 'codex', detected: true, signedIn: false },
    { id: 'fake', detected: true, signedIn: true },
  ],
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};
const FAR = {
  id: 'far',
  name: 'build-server-in-the-basement-rack-07',
  address: 'me@far',
  socketPath: '',
  capabilities: {},
  harnesses: [],
  lastHeartbeat: Date.now() - 2 * 3_600_000 - 60_000,
  setup: '',
};

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_HARNESSES: JSON.stringify(BOX.harnesses),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [BOX, FAR] } } },
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('chip menu and Machines: one status line per machine, the ⋯ menu and Rename, and the sign-in and Add machine sheets', async ({
  page,
  harness,
}) => {
  // the new chat's Run on chip in the context bar
  await page.getByRole('button', { name: /^Run on: This Mac/ }).click();
  const menu = page.getByRole('menu', { name: 'My machines' });
  // a picker only: box runs chats (an agent is ready there), so its line is only the one limit it declares (a shell, no browser or computer use), and no row signs in; the far machine says Offline
  const row = (name: RegExp) => menu.getByRole('menuitemradio').filter({ has: page.locator('.menu-title', { hasText: name }) });
  await expect(row(/^box$/).locator('.host-dot')).toHaveClass(/online/, { timeout: 45_000 });
  await expect(row(/^box$/).locator('.menu-desc')).toHaveText('No browser or computer use');
  await expect(row(/^build-server/).locator('.menu-desc')).toHaveText('Offline');
  await expect(menu.getByText(/Sign in to/)).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3);
  await shootBoth(page, harness.app, 'chip-menu-machines');
  // Add machine… opens the Add a machine sheet in place, over the new chat
  await menu.getByRole('menuitem', { name: /Add machine/ }).click();
  const inPlace = page.locator('.dialog').filter({ has: page.locator('.dialog-head', { hasText: 'Add a machine' }) });
  await expect(inPlace.locator('.add-machine-sheet')).toBeVisible();
  await inPlace.locator('.dialog-head').getByRole('button', { name: 'Close' }).click();
  await expect(inPlace).toHaveCount(0);
  await openConnections(page);
  const machines = page.getByRole('region', { name: 'Machines' });
  await expect(machines.getByRole('heading', { name: 'Machines' })).toBeVisible();
  const box = machines.locator('.machine-item', { has: page.locator('.machine-name', { hasText: /^box$/ }) });
  await expect(box.locator('.machine-status')).toHaveText('Claude Code and Codex need sign-in');
  await expect(box.getByRole('button', { name: 'Sign in to Claude Code on box' })).toHaveText('Sign in');
  await expect(box.locator('.btn-pill')).toHaveCount(1);
  const far = machines.locator('.machine-item', { hasText: 'build-server-in-the-basement-rack-07' });
  await expect(far.locator('.machine-status')).toHaveText('Offline · Its Host isn’t running · seen 2 h ago');
  // ssh answers and its Host does not (#5104), and Check again is still offered in place
  await expect(far.getByRole('button', { name: /^Check again/ })).toHaveCount(1);
  await expect(machines).not.toContainText('fake');
  await expect(machines.getByRole('button', { name: /^How machines sign in/ })).toContainText('Each machine');
  await page.getByRole('heading', { name: 'Machines' }).scrollIntoViewIfNeeded();
  // the page must not scroll sideways: list what sticks out of the scroller, if anything
  const sideways = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('*')]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
      .map((el) => {
        const box = el.getBoundingClientRect();
        const wide = [...el.querySelectorAll<HTMLElement>('*')].filter((c) => c.getBoundingClientRect().right > box.right + 1);
        return `${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}: ${wide
          .slice(0, 4)
          .map((c) => `${c.tagName}.${c.className}`)
          .join(' | ')}`;
      }),
  );
  test.info().annotations.push({ type: 'sideways', description: JSON.stringify(sideways) });
  await shootBoth(page, harness.app, 'settings-my-machines');
  expect(sideways).toEqual([]);

  // the ⋯ menu: the other sign-in, Open terminal, Rename, Remove
  await box.getByRole('button', { name: 'More for box' }).click();
  const more = page.getByRole('menu');
  await expect(more.getByRole('menuitem')).toHaveText(['Details', 'Rename', 'Sign in to Codex', 'Open terminal', 'Remove']);
  await shootBoth(page, harness.app, 'settings-my-machines-menu');
  // Rename goes through main's registry: the list that comes back names it everywhere
  await more.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.locator('.dialog', { hasText: 'Rename machine' });
  await rename.getByLabel('Machine name').fill('Build box');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(rename).toHaveCount(0);
  await expect(machines.locator('.machine-name').first()).toHaveText('Build box');

  // How machines sign in: fields only for the chosen choice
  await machines.getByRole('button', { name: /^How machines sign in/ }).click();
  const signin = page.locator('.dialog', { hasText: 'How machines sign in' });
  await expect(signin).toContainText('Applies to every machine.');
  await signin.getByRole('radio', { name: /My API keys/ }).click();
  await expect(signin.getByLabel('Anthropic key')).toBeVisible();
  await expect(signin.getByLabel('OpenAI key')).toBeVisible();
  // every agent that can take this Mac's key has its row
  for (const k of ['Gemini key', 'xAI key', 'DeepSeek key']) await expect(signin.getByLabel(k)).toBeVisible();
  await shootBoth(page, harness.app, 'signin-sheet-keys');
  await signin.getByRole('radio', { name: /My organization/ }).click();
  await expect(signin.getByLabel('Anthropic key')).toHaveCount(0);
  await expect(signin.getByLabel('Sign-in URL')).toBeVisible();
  await shootBoth(page, harness.app, 'signin-sheet-org');
  await signin.getByRole('button', { name: /^More:/ }).click();
  await expect(signin.getByLabel('Session length in hours')).toHaveValue('8');
  await shootBoth(page, harness.app, 'signin-sheet-org-more');
  await signin.getByRole('button', { name: 'Cancel' }).click();
  await expect(signin).toHaveCount(0);

  // Add machine: one field with what was found under it, Any network as a link
  await machines.getByRole('button', { name: 'Add machine' }).click();
  const add = page.locator('.dialog', { hasText: 'Add a machine' });
  await expect(add.getByLabel('Machine', { exact: true })).toBeVisible();
  await expect(add.getByText('Looking for machines…')).toHaveCount(0, { timeout: 30_000 });
  await shootBoth(page, harness.app, 'add-machine-nearby');
  await add.getByRole('button', { name: 'Any network (add by command)' }).click();
  await expect(add.getByRole('button', { name: /^(Copy|Get a new command|Try again)$/ })).toBeVisible({ timeout: 30_000 });
  await shootBoth(page, harness.app, 'add-machine-any-network');
  await add.getByRole('button', { name: 'Back' }).click();
  await expect(add.getByLabel('Machine', { exact: true })).toBeVisible();
  await shootBoth(page, harness.app, 'add-machine-ssh');
});
