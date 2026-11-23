// Signing in to an agent on a machine from this Mac (#2709, 2026-11-02), in the real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1) against the fake `ssh`, whose machine has Kimi Code installed but signed out:
// the machine menu stays a picker; the composer keeps Kimi Code picked and only Send waits ("Sign in first") (the machine's one line says "Kimi Code needs sign-in", no sign-in row); picking the machine for a Kimi Code chat in the Run on chip shows the sign-in card above the composer (and no second routing line);
// Sign in starts the machine's sign-in and shows its code in the card with Copy (no link: nothing opens a browser); a vendor failure reads as one plain line with the vendor's words behind Details, and Try again starts again.
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shoot } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-signin-card-')));
fs.mkdirSync(path.join(ROOT, 'app', '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const FAIL = path.join(ROOT, 'login-fail');
const HARNESSES = [{ id: 'kimi', detected: true, signedIn: false }];
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: HARNESSES,
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};
const VENDOR_ERROR = 'kimi: device authorization was rejected by the server (HTTP 403, request id 7f3a9c).';

test.afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_HARNESSES: JSON.stringify(HARNESSES),
    FAKE_HOST_LOGIN_CODE: 'WXYZ-1234',
    FAKE_HOST_LOGIN_FAIL: FAIL,
    FAKE_HOST_LOGIN_ERROR: VENDOR_ERROR,
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
test.setTimeout(180_000);

// the new chat's Run on chip in the context bar
const chip = (page: Page) => page.locator('button.host-ctx');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
const machineRow = (page: Page, name: string) =>
  menu(page)
    .getByRole('menuitemradio')
    .filter({ has: page.locator('.menu-title', { hasText: new RegExp(`^${name}$`) }) });
const card = (page: Page) => page.locator('.host-signin-card');
const logins = () => (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).filter((c) => c.method === 'host.login');

test('the menu only picks; the Kimi Code chat on a machine where it is signed out signs in from the card, shows the code, and words a failure plainly', async ({
  page,
}) => {
  // the chat's agent is Kimi Code
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();

  // the menu: the machine says what it needs in one line, and nothing in it signs in
  await chip(page).click();
  await expect(machineRow(page, 'box').locator('.menu-desc')).toHaveText('Kimi Code needs sign-in', { timeout: 45_000 });
  await expect(machineRow(page, 'This Mac').locator('.menu-desc')).toHaveCount(0);
  await expect(menu(page).getByText(/Sign in to/)).toHaveCount(0);
  await expect(page.locator('.host-menu .perm-mode-note')).toHaveCount(0);
  await shoot(page, 'host-signin-menu');

  // picking it for the chat (its folder first) brings the card, before anything is sent
  await machineRow(page, 'box').click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(card(page)).toBeVisible({ timeout: 45_000 });
  await expect(card(page)).toHaveAttribute('role', 'status');
  await expect(card(page)).toHaveAttribute('aria-label', 'Sign in to Kimi Code on box');
  await expect(card(page)).not.toHaveClass(/\bfa-banner\b/);
  await expect(card(page).locator('.host-signin-title')).toHaveText('Sign in to Kimi Code on box');
  // nothing on box stands in for Kimi Code, so the line says what waits on the sign-in; the routing note does not repeat the card
  await expect(card(page).locator('.host-signin-line')).toHaveText('Sign in to send messages here');
  await expect(page.locator('[data-host-agent-note]')).toHaveCount(0);
  await expect(card(page).locator('.host-signin-act.btn-pill.primary')).toHaveText('Sign in');
  // the agent picked stays picked (the model button names it while the machine reports no models); only Send waits, and says why
  await expect(page.getByRole('button', { name: 'Select model' })).toHaveText('Kimi Code');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('hello box');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  // a disabled button gets no pointer events: its tooltip anchor does
  await page.locator('.tooltip-anchor', { has: send }).hover();
  await expect(page.locator('.tooltip').filter({ hasText: 'Sign in first' })).toBeVisible();
  await shoot(page, 'host-signin-card');

  // Sign in: the machine's sign-in starts, and its code shows in the card
  await card(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(card(page).locator('.host-signin-code')).toHaveText('WXYZ-1234', { timeout: 30_000 });
  await expect(card(page).locator('.host-signin-line')).toContainText('Enter this code in the page that opened');
  await expect(card(page).locator('.host-signin-code + button.host-signin-link')).toHaveText('Copy');
  await expect(card(page).locator('.host-signin-act.btn-pill.ghost')).toHaveText('Cancel');
  await expect(card(page).getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  expect(logins().map((c) => c.params.harness)).toEqual(['kimi']);
  await shoot(page, 'host-signin-card-code');

  // the vendor's failure: one plain line, its own words only behind Details, and Try again
  fs.writeFileSync(FAIL, '');
  await expect(card(page).locator('.host-signin-line')).toHaveText("Couldn't sign in to Kimi Code", { timeout: 30_000 });
  await expect(card(page).getByText(VENDOR_ERROR)).not.toBeVisible();
  await card(page).locator('.host-signin-details summary').click();
  await expect(card(page).getByText(VENDOR_ERROR)).toBeVisible();
  await shoot(page, 'host-signin-card-failed');
  fs.rmSync(FAIL, { force: true });
  await card(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card(page).locator('.host-signin-code')).toHaveText('WXYZ-1234', { timeout: 30_000 });
  expect(logins().length).toBe(2);
});
