// e2e-runner: bench
// Remote Run S7 in the real app: zero configuration. A fresh app (isolated data dir) with the admin's managed policy file present shows Settings › My machines › How machines sign in on "My organization" with the sign-in URL, gateways, client ID and session length already filled in, locked, and "Managed by your organization."; a later invalid rewrite of the file keeps the last good block and says why on the same sheet.
// The file lives where an admin puts it (/Library/Application Support/MoPilot Code/managed-policy.json, owned by root: the app ignores any other), so it is installed with sudo, which only a CI runner or an isolated VM allows. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-org-managed.spec.ts`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';

test.skip(process.platform !== 'darwin', 'the managed file path and root ownership checked here are the Mac app’s');
test.skip(!process.env.GITHUB_ACTIONS && !process.env.MOPILOT_ACCEPT_VM, 'a runner or an isolated VM only: it installs a root-owned file');

const DIR = '/Library/Application Support/MoPilot Code';
const FILE = path.join(DIR, 'managed-policy.json');
const ISSUER = 'https://login.acme.example/realms/acme';
const POLICY = {
  version: 1,
  orgAccess: {
    issuer: ISSUER,
    clientId: 'managed-client',
    gateways: { anthropic: 'https://gw.acme.example/anthropic', openai: 'https://gw.acme.example/openai/v1' },
    leaseHours: 6,
  },
};
const sudo = (...args: string[]) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' });
/** Puts `text` where the admin's file is: root-owned and writable by root only, the one kind the app trusts. */
function install(text: string) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-')), 'managed-policy.json');
  fs.writeFileSync(tmp, text);
  sudo('install', '-d', '-m', '755', '-o', 'root', '-g', 'wheel', DIR);
  sudo('install', '-m', '644', '-o', 'root', '-g', 'wheel', tmp, FILE);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
const hadDir = fs.existsSync(DIR);

test.describe.configure({ mode: 'serial' });
test.setTimeout(3 * 60_000);
// the file exists before the app's first start: a fresh app reads it at launch
test.beforeAll(() => install(JSON.stringify(POLICY)));
test.afterAll(() => {
  sudo('rm', '-f', FILE);
  if (!hadDir) sudo('rmdir', DIR);
});
test.use({ harnesses: 'claude', env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.cloud=0' } });

test('S7: the managed file fills organization sign-in and locks it; an invalid rewrite keeps it and says why', async ({ page }) => {
  await openConnections(page);
  const machines = page.getByRole('region', { name: 'Machines' });
  // organization sign-in is already the way machines sign in, with nothing typed
  const row = machines.getByRole('button', { name: /^How machines sign in/ });
  await expect(row).toContainText('My organization');
  await row.click();
  const sheet = page.locator('.dialog', { hasText: 'How machines sign in' });
  await expect(sheet.getByRole('radio', { name: /My organization/ })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('radio', { name: /Each machine/ })).toBeDisabled();
  await expect(sheet.getByRole('radio', { name: /My API keys/ })).toBeDisabled();
  await expect(sheet.locator('.signin-managed')).toHaveText('Managed by your organization.');
  const locked = async () => {
    const fields: [string, string][] = [
      ['Sign-in URL', ISSUER],
      ['Gateway URL', POLICY.orgAccess.gateways.anthropic],
      ['Client ID', 'managed-client'],
      ['OpenAI gateway URL', POLICY.orgAccess.gateways.openai],
      ['Session length in hours', '6'],
    ];
    for (const [label, value] of fields) {
      const input = sheet.getByLabel(label, { exact: true });
      await expect(input, label).toHaveValue(value);
      await expect(input, label).toHaveAttribute('readonly', '');
    }
  };
  await locked();
  await expect(sheet.getByRole('button', { name: 'Sign in' })).toBeEnabled();

  // an admin's bad rewrite: the last good block stays in force and the sheet says why
  install('{ "version": 1, "orgAccess": ');
  await expect(sheet.locator('.signin-managed')).toContainText('Managed by your organization. The managed policy file is not valid', {
    timeout: 30_000,
  });
  await locked();

  // a good rewrite is taken again, and the reason goes
  install(JSON.stringify({ ...POLICY, organization: 'Acme' }));
  await expect(sheet.locator('.signin-managed')).toHaveText('Managed by Acme.', { timeout: 30_000 });
});
