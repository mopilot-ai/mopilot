// A chat on a machine uses that machine's own desktop, in the real app (G8 #3903), against the real Host wire on a fake desktop helper (fixtures/fake-ssh/host-wire.mjs with FAKE_HOST_DESKTOP=1: the Host's lease, grants and call-id code; only the helper and the model are fake).
// A message "desktop Notes" makes the chat's turn ask for Notes and look at the screen. The call goes to this app over the tool relay, the app's own card asks the person, and the screenshot is taken by the machine's helper: the Host's log shows the lease and the helper's screenshot, and this Mac's own computer-use helper (a fake on a socket) is never asked to do anything.
// e2e-covers: electron/app/hostCapabilityRelay.cjs
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
import { settingsEntry } from './fixtures/settings';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-desktop-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')));
const SOCK = path.join(RESIDENT, 'w.sock');
const CAPS = { shell: true, iab: true, desktop: true };

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
    env: { ...process.env, FAKE_HOST_WIRE_SOCK: SOCK, FAKE_HOST_LOG: LOG, FAKE_HOST_DESKTOP: '1' },
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
  // the runner is a VM nobody sits at: the bench switch counts the user as present, as for this Mac's own desktop specs
  MOPILOT_BENCH_ATTENDED: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_WIRE_SOCK: SOCK,
  FAKE_HOST_DESKTOP: '1',
  FAKE_HOST_CAPS: JSON.stringify(CAPS),
  FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'kimi', detected: true, signedIn: true }]),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
// computerHelper: this Mac's own computer-use helper is a fake on a socket, so what it is asked can be read
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED, computerHelper: true });

type Call = { method: string; params: Record<string, any> };
const calls = (): Call[] => readJsonLineLog(LOG) as Call[];
const asked = (method: string) => calls().filter((c) => c.method === method).length;
/** What the machine's desktop helper was asked, by method. */
const hostHelper = (method: string) => calls().filter((c) => c.method === 'desktop.helper' && c.params.method === method).length;

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const main = (page: Page) => page.getByRole('main');

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

test("a Host chat looks at the machine's own desktop; this Mac's computer-use helper is never asked", async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'desktop Notes');
  // the app's own card asks the person to let the chat use Notes
  const card = page.locator('.sage-approval');
  await expect(card).toContainText('Notes', { timeout: 60_000 });
  await pickScope(card, /Allow in this chat/);
  await expect(main(page).getByText('fake-host: desktop ok')).toBeVisible({ timeout: 60_000 });

  // the lease and the screenshot happened on the machine
  expect(asked('desktop.lease')).toBeGreaterThanOrEqual(1);
  expect(asked('desktop.call')).toBeGreaterThanOrEqual(1);
  expect(hostHelper('screenshot')).toBeGreaterThanOrEqual(1);
  expect(hostHelper('apps.resolve')).toBeGreaterThanOrEqual(1);

  // and nothing was asked of this Mac's helper that looks at, finds apps on, or acts on a screen
  const local = (harness.helper?.log ?? []).map((l) => l.method);
  for (const m of ['screenshot', 'apps.resolve', 'apps.list', 'target.info', 'control.acquire', 'app.screenshot'])
    expect(local, `this Mac's helper was asked ${m}`).not.toContain(m);
  expect(local.filter((m) => m.startsWith('input.'))).toEqual([]);

  // Settings -> Computer use lists what was approved on the machine under its name, apart from this Mac's lists, and takes it back
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Computer use' }).click();
  await expect(page.locator('.settings-title')).toHaveText('Computer use');
  const onBox = page.locator('.settings-group', { hasText: 'On box' });
  await expect(onBox).toContainText('Notes');
  await expect(page.locator('.settings-group', { hasText: 'Allowed in a chat' })).not.toContainText('Notes');
  await onBox.getByRole('button', { name: 'Remove Notes' }).click();
  await expect(page.locator('.settings-group', { hasText: 'On box' })).toHaveCount(0);
});

test('a Host chat needs an approval on this Mac for each read and desktop action', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  const card = page.locator('.approval-card[data-kind="hostAsk"]');
  const approve = async (tool: string, button: string) => {
    await expect(card).toContainText('Use apps on this Mac', { timeout: 60_000 });
    await expect(card).toContainText('This chat on box');
    await expect(card).toContainText(tool);
    await card.getByRole('button', { name: new RegExp(`^${button}`) }).click();
  };
  const local = () => (harness.helper?.log ?? []).map((l) => l.method);
  await send(page, 'use this Mac');
  await approve('desktop_list_granted_applications', 'Deny');
  await expect(main(page).getByText('fake-host: this Mac denied')).toBeVisible({ timeout: 60_000 });
  expect(local()).not.toContain('apps.open');

  await send(page, 'open Notes on this Mac');
  await approve('desktop_list_granted_applications', 'Allow once');
  await approve('desktop_request_access', 'Allow once');
  const appGrant = page.locator('.sage-approval[data-kind="computerAccessSet"]');
  await expect(appGrant).toContainText('Notes');
  await pickScope(appGrant, /Allow in this chat/);
  await approve('desktop_open_application', 'Allow once');
  await expect(main(page).getByText('fake-host: this Mac ok')).toBeVisible({ timeout: 60_000 });
  expect(local()).toContain('apps.open');
  await expect(card).toHaveCount(0);
  expect(asked('desktop.lease')).toBe(0);
});

test.describe('the older computer_* tools', () => {
  // shared.computerUse.parityTools off: this Mac registers computer_* (they act on this Mac's screen)
  test.use({ seed: { ...SEED, files: remoteFlags(COMPUTER_TOOLS) } });

  test('a chat on a machine is never offered them, and a call for one is refused without touching this Mac', async ({ harness }) => {
    const page = harness.page;
    await pickTarget(page);
    await send(page, 'computer click');
    await expect(main(page).getByText(/fake-host: computer [a-z_]+/)).toBeVisible({ timeout: 90_000 });
    await expect(main(page).getByText('fake-host: computer ok')).toHaveCount(0);
    // the tools this app told the machine about: the browser's and the desktop's, never computer_*
    const synced = calls().filter((c) => c.method === 'host.toolsSync');
    const names = synced.flatMap((c) => (c.params.tools as { name: string }[]).map((t) => t.name));
    expect(synced.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith('computer_'))).toEqual([]);
    // and this Mac's helper was never asked to act
    expect((harness.helper?.log ?? []).filter((l) => l.method.startsWith('input.'))).toEqual([]);
  });
});

test("a Host chat's desktop is a tab in the pane: drawn from the machine's frames under its name, the user's input reaches it only after Take over, and the agent waits while they drive", async ({
  harness,
}) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'desktop Notes wait');
  const card = page.locator('.sage-approval');
  await expect(card).toContainText('Notes', { timeout: 60_000 });
  await pickScope(card, /Allow in this chat/);
  await expect(main(page).getByText('fake-host: desktop ok')).toBeVisible({ timeout: 60_000 });

  // the desktop opens as a tab of the machine, with its picture and a line that says whose desktop it is
  const frame = page.locator('.host-desktop .remote-view-frame');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('.host-desktop .remote-view-bar')).toHaveText("This is box's desktop, not this Mac.");
  await expect(page.getByText('Desktop on box').first()).toBeVisible();
  await shootBoth(page, harness.app, 'host-desktop-pane');
  expect(hostHelper('screenshot')).toBeGreaterThanOrEqual(1);

  // the agent has the desktop: a click on its picture goes nowhere
  const clicks = () => hostHelper('input.click');
  await frame.click();
  await page.waitForTimeout(1000);
  expect(clicks()).toBe(0);

  // taking over sends the user's click to the machine's desktop, and the bar says what it is
  const bar = page.locator('.browser-agent-bar');
  await expect(bar).toContainText('Agent is using this desktop');
  await bar.getByRole('button', { name: 'Take over' }).click();
  await expect(bar).toContainText('You took over this desktop for this turn');
  await expect(page.locator('.host-desktop .remote-view-bar')).toHaveText("You are driving box's desktop, not this Mac.");
  await shootBoth(page, harness.app, 'host-desktop-pane-takeover');
  await frame.click();
  await expect.poll(clicks, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // handing it back stops it again; Stop ends the turn
  await bar.locator('button[title="Hand the desktop back to the agent"]').click();
  await expect(bar).not.toContainText('You took over');
  const sent = clicks();
  await frame.click();
  await page.waitForTimeout(1500);
  expect(clicks()).toBe(sent);
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
});

test("the agent's click on a Host's desktop reaches the pane as a cursor placed by the frame's layout, and the click reaches the machine's helper", async ({
  harness,
}) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'desktop Notes click wait');
  const card = page.locator('.sage-approval');
  await expect(card).toContainText('Notes', { timeout: 60_000 });
  await pickScope(card, /Allow in this chat/);
  // a click needs the real pointer on the machine: its own card, named by the machine
  const control = page.locator('.sage-approval', { hasText: 'mouse and keyboard in Notes on box' });
  await expect(control).toBeVisible({ timeout: 60_000 });
  await control
    .getByRole('button', { name: /^Allow/ })
    .first()
    .click();
  await expect(main(page).getByText('fake-host: click ok')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.host-desktop .remote-view-frame')).toBeVisible({ timeout: 30_000 });
  // the cursor was placed by the display layout of the frame the pane shows (its shapes are drawn on animation frames, which a window nobody looks at does not get: the plan's clock is unit-tested)
  const cursor = page.locator('.host-desktop-cursor');
  await expect(cursor).toHaveAttribute('data-cursor-version', /^\d+$/, { timeout: 15_000 });
  await expect(cursor).toHaveAttribute('data-frame-version', (await cursor.getAttribute('data-cursor-version')) ?? '');
  expect(hostHelper('input.click')).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
});
