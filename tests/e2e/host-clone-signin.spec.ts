// Use this Mac's sign-in for one clone, in the real renderer and main against a fake `ssh` Host: a clone the machine cannot sign in to offers the button; the click lends this Mac's sign-in (read by `git credential fill` from a temp credential store, so the real reader runs) to that one clone, with a new key; an address this Mac has no sign-in for says so with no button; screenshots in both themes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN, NO_HOST_HERE } from './fixtures/fakeSsh';

// its machine is this runner (fixtures/fakeSsh.ts NO_HOST_HERE)
test.skip(process.platform === 'win32', NO_HOST_HERE);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-signin-e2e-')));
fs.mkdirSync(path.join(ROOT, 'projects'), { recursive: true });
const LOG = path.join(ROOT, 'calls.log');
const STORE = path.join(ROOT, 'credentials');
const GITCONFIG = path.join(ROOT, 'gitconfig');
const TOKEN = 'ghp_e2e_read_only_token';
// this Mac's own sign-in for one test host, in the way git reads any: a credential store file
fs.writeFileSync(STORE, `https://octo:${TOKEN}@git.example.test\n`);
fs.writeFileSync(GITCONFIG, `[credential]\n\thelper = store --file=${STORE}\n`);

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

test.use({
  harnesses: 'claude',
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    GIT_CONFIG_GLOBAL: GITCONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('a private clone offers this Mac’s sign-in; the click lends it to one clone; a host this Mac has none for says so', async ({
  page,
  harness,
}) => {
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Clone repository…' }).click();
  const address = dialog.getByLabel('Repository address');
  const offer = dialog.getByRole('button', { name: 'Use this Mac’s sign-in' });

  // a host this Mac has no sign-in for: one line, and the button is gone
  await address.fill('https://nowhere.example.test/org/private-tool.git');
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This machine can’t sign in to that repository.');
  await expect(offer).toBeVisible();
  await expect(dialog.locator('.host-picker-signin')).toContainText('Used once, not saved on the machine.');
  await shootBoth(page, harness.app, 'signin-offer');
  await offer.click();
  await expect(dialog.getByRole('alert')).toHaveText('This Mac has no sign-in for that address.');
  await expect(offer).toHaveCount(0);
  await shootBoth(page, harness.app, 'signin-none');

  // a host it has one for: the first attempt borrows nothing, the click lends it to one new attempt
  await address.fill('https://git.example.test/org/private-app.git');
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(offer).toBeVisible();
  await offer.click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  expect(fs.existsSync(path.join(ROOT, 'private-app', '.git'))).toBe(true);
  const calls = fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.method === 'git.clone' && c.params.url.includes('git.example.test'));
  expect(calls).toHaveLength(2);
  expect(calls[0].params.credential).toBeUndefined();
  expect(calls[1].params.credential).toEqual({ username: 'octo', password: TOKEN });
  expect(calls[1].params.key).not.toBe(calls[0].params.key);
});
