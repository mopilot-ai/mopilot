// The remote browser pane in the real app (Host work package 2.6), against the real Host wire on a fake Chromium (fixtures/fake-ssh/host-wire.mjs: the Host's protocol, browser service and tool relay; only Chromium and the model are fake).
// A chat runs on a machine and its turn calls `browser_navigate`: the call goes to this app over the tool relay (site grant card included), the app drives the machine's browser, and the pane shows the page by its frames. The user's input reaches the page only while they have
// taken the tab over, nothing of it ever opens in this Mac's own browser, and Stop settles even when the page never answers: the machine's browser is told to stop what it was loading.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { pickScope } from './fixtures/approvalScope';
import { openHarnessList } from './fixtures/harnessPicker';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-pane-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')));
const SOCK = path.join(RESIDENT, 'w.sock');
const CAPS = { shell: true, iab: true };

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: CAPS,
  harnesses: [{ id: 'kimi', detected: true, signedIn: true }],
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

let resident: ChildProcess | null = null;
test.beforeAll(async () => {
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-wire.mjs')], {
    env: { ...process.env, FAKE_HOST_WIRE_SOCK: SOCK, FAKE_HOST_LOG: LOG },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  (await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 20_000 })).destroy();
});
test.afterAll(() => {
  resident?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(RESIDENT, { recursive: true, force: true });
});

const ENV = {
  MOPILOT_HOST_DEV: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_WIRE_SOCK: SOCK,
  FAKE_HOST_CAPS: JSON.stringify(CAPS),
  FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'kimi', detected: true, signedIn: true }]),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED });

type Call = { method: string; params: Record<string, any> };
const calls = (): Call[] => readJsonLineLog(LOG) as Call[];
/** What the machine's browser was asked (CDP commands), by method. */
const cdp = (method: string) => calls().filter((c) => c.method === 'cdp' && c.params.method === method).length;
const asked = (method: string) => calls().filter((c) => c.method === method).length;

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const main = (page: Page) => page.getByRole('main');
// the chat's Stop and the pane's agent bar both have one: the chat's comes first
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Pick Kimi Code and the folder on the machine, as the new chat's target. */
async function pickTarget(page: Page) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(path.join(ROOT, 'projects'));
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // the project chip names only the folder; the Run on chip beside it names the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveText('app');
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', 'Change project: app · box');
  await expect(page.locator('button.host-ctx')).toHaveAttribute('aria-label', /^Run on: box, /);
}

/** The first visit to a site asks the person; this answers it for the chat. */
async function allowSite(page: Page, host: string) {
  const card = page.locator('.sage-approval');
  await expect(card).toContainText(host, { timeout: 60_000 });
  await pickScope(card, /Allow in this chat/);
  await expect(card).toHaveCount(0);
}

test.beforeEach(() => {
  fs.rmSync(OFFLINE, { force: true });
  fs.rmSync(LOG, { force: true });
});
test.setTimeout(240_000);

/** What main reports as ignored (a failure it survives) goes to the test output, where a run on a runner can be read. */
const showIgnored = (harness: { app: { process(): NodeJS.Process | any } }) =>
  harness.app.process().stdout?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) if (line.includes('[ignored]')) console.log(line);
  });

test("a Host chat's page is shown by its frames, the user's input reaches it only while they have taken the tab over, and none of it opens in this Mac's own browser", async ({
  harness,
}) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'browse http://pane.test/page wait');
  await allowSite(page, 'pane.test');
  await expect(main(page).getByText(/fake-host: browsed .*pane\.test\/page/)).toBeVisible({ timeout: 60_000 });

  // the page is drawn from the machine's frames, in a pane tab that belongs to the Host; the tool ran on the machine's browser and nothing was loaded here
  const frame = page.locator('.remote-view .remote-view-frame');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(page.locator('webview, .browser-view:not(.remote-view)')).toHaveCount(0);
  await shootBoth(page, harness.app, 'remote-pane');
  expect(asked('browser.open')).toBe(1);
  expect(cdp('Page.captureScreenshot')).toBeGreaterThan(0);
  expect(cdp('Page.navigate')).toBeGreaterThanOrEqual(1);

  // the agent has the tab: a click on its picture goes nowhere
  const mouse = () => cdp('Input.dispatchMouseEvent');
  const keys = () => cdp('Input.dispatchKeyEvent');
  await frame.click();
  await page.waitForTimeout(1000);
  expect(mouse()).toBe(0);

  // taking the tab over sends the user's pointer and keys to the page
  const bar = page.locator('.browser-agent-bar');
  await bar.getByRole('button', { name: 'Take over' }).click();
  await expect(bar).toContainText('You took over this tab for this turn');
  await shootBoth(page, harness.app, 'remote-pane-takeover');
  await frame.click();
  await expect.poll(mouse, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('a');
  await expect.poll(keys, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // handing it back stops it again
  await bar.locator('button[title="Hand the tab back to the agent"]').click();
  await expect(bar).not.toContainText('You took over');
  const sent = { mouse: mouse(), keys: keys() };
  await frame.click();
  await page.keyboard.press('b');
  await page.waitForTimeout(1500);
  expect({ mouse: mouse(), keys: keys() }).toEqual(sent);

  // the turn is still open (the agent is waiting); Stop ends it
  await stop(page).first().click();
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });
});

test('Stop settles when the page never answers: the call ends, and the machine is told to stop the chat’s browser', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'browse hang');
  await allowSite(page, 'pane.test');
  // the machine received the navigation and never answered it
  await expect.poll(() => cdp('Page.navigate'), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  await expect(stop(page).first()).toBeVisible();
  await stop(page).first().click();
  // the turn ends, the call is told it was stopped, and the machine's browser was asked to stop what it was loading
  await expect(main(page).getByText('fake-host: browser failed (aborted)')).toBeVisible({ timeout: 45_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => asked('browser.abort'), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => cdp('Page.stopLoading'), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
});

test('a dev server on the machine offers to open on this Mac', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'browse http://localhost:5173/ wait');
  await allowSite(page, 'localhost');
  const bar = page.locator('.remote-view-bar');
  await expect(bar).toContainText('Open on this Mac', { timeout: 60_000 });
  await shootBoth(page, harness.app, 'remote-pane-open-here');
  await stop(page).first().click();
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });
});
