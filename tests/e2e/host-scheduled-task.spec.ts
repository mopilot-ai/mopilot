// A scheduled task that runs on a remote machine, in the real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1), against the fake `ssh` that serves the Host protocol and the resident fake Host (fixtures/fake-ssh/host-chats.cjs):
// the task dialog's Runs on picks the machine, its folder there and says how a run signs in; Run now starts the run's chat on the machine and its reply streams in;
// a time the scheduler fires while the machine is away makes the chat, its message waits for the machine and goes when it is back; an agent signed out there fails the run with the reason in the task's history.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { createdTaskText } from './fixtures/tasks';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-sched-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')));
const SOCK = path.join(RESIDENT, 'h.sock');
// Kimi Code is signed in on the machine; Claude Code is installed there and signed out
const AGENTS = [
  { id: 'kimi', detected: true, signedIn: true },
  { id: 'claude', detected: true, signedIn: false },
];
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: AGENTS,
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

let resident: ChildProcess | null = null;
test.beforeAll(async () => {
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: SOCK, FAKE_HOST_LOG: LOG },
    stdio: 'ignore',
  });
  (await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 10_000 })).destroy();
});
test.afterAll(() => {
  resident?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(RESIDENT, { recursive: true, force: true });
});
test.beforeEach(() => {
  fs.rmSync(OFFLINE, { force: true });
  fs.rmSync(LOG, { force: true });
});
test.setTimeout(180_000);

const ENV = {
  MOPILOT_HOST_DEV: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_CHATS_SOCK: SOCK,
  FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED });

const main = (page: Page) => page.getByRole('main');
const automations = (h: Harness) => path.join(h.dir, 'home', '.mopilot', 'automations');
const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

async function pick(page: Page, label: string, option: string) {
  await page
    .getByRole('dialog', { name: /Schedule a task|Edit task/ })
    .getByRole('button', { name: label })
    .click();
  await page
    .getByRole('menuitemcheckbox')
    .filter({ has: page.locator('.menu-title', { hasText: new RegExp(`^${option}$`) }) })
    .or(page.getByRole('menuitemcheckbox', { name: option, exact: true }))
    .click();
}

test('Runs on a machine: its folder, how a run signs in, and Run now starts the chat there', async ({ harness }) => {
  const page = harness.page;
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a task' });
  await dialog.getByPlaceholder('Instructions...').fill('nightly box check');
  // the machine answers once its tunnel is up: it is listed then
  await expect(dialog.getByRole('button', { name: 'Runs on' })).toHaveText('This Mac', { timeout: 45_000 });
  await pick(page, 'Runs on', 'box');
  // the machine has Kimi Code signed in: the task gives way to it, and Create waits for a folder there
  await expect(dialog.getByTestId('sched-machine-credential')).toHaveText('Signed in on box');
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Folder on the machine' }).click();
  const picker = page.locator('.dialog');
  await expect(picker.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await picker.locator('.host-picker-open', { hasText: 'projects' }).click();
  await picker.locator('.host-picker-open', { hasText: 'app' }).click();
  await expect(picker.locator('.host-picker-path')).toHaveText(FOLDER);
  await picker.getByRole('button', { name: 'Use this folder' }).click();
  await expect(dialog.getByRole('button', { name: 'Folder on the machine' })).toHaveText('app');
  // Claude Code is signed out there: the dialog says so before Save
  await dialog.getByRole('button', { name: 'Advanced' }).click();
  await pick(page, 'Run with', 'Claude Code');
  await expect(dialog.getByTestId('sched-machine-credential')).toHaveText('Sign in to Claude Code on box');
  await shootBoth(page, harness.app, 'sched-runs-on-signed-out');
  await pick(page, 'Run with', 'Kimi Code');
  await expect(dialog.getByTestId('sched-machine-credential')).toHaveText('Signed in on box');
  await shootBoth(page, harness.app, 'sched-runs-on');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Scheduled task saved')).toBeVisible();

  // kept in MoPilot's folder with its machine and the machine's folder, and shown on the task
  await expect.poll(() => createdTaskText(automations(harness), 'nightly box check')).toContain('host_id = "ssh:me@box"');
  const file = createdTaskText(automations(harness), 'nightly box check');
  expect(file).toContain('harness = "acp:kimi"');
  expect(file).toContain(FOLDER);
  await expect(page.getByTestId('task-machine')).toHaveText('On box');

  // Run now: the chat starts on the machine, in its folder, and nothing runs on this Mac
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(main(page).getByText('fake-host: nightly box check', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(calls().find((c) => c.method === 'chat.start')?.params).toMatchObject({ harness: 'acp:kimi', cwd: FOLDER });
  expect(harness.acpLog('kimi').some((l) => l.kind === 'in' && l.msg.method === 'session/prompt')).toBe(false);
});

/** A machine task due once a minute, written where MoPilot keeps tasks. */
const seedTask = (id: string, harness: string, prompt: string) => (d: Dirs) => {
  const dir = path.join(d.home, '.mopilot', 'automations', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'automation.toml'),
    [
      'version = 1',
      `id = "${id}"`,
      'kind = "cron"',
      `name = "${id}"`,
      `prompt = "${prompt}"`,
      'status = "ACTIVE"',
      'rrule = "FREQ=MINUTELY;INTERVAL=1"',
      `harness = "${harness}"`,
      'host_id = "ssh:me@box"',
      `cwds = ["${FOLDER}"]`,
      `updated_at = ${Date.now()}`,
      '',
    ].join('\n'),
  );
};

test.describe('fired by the scheduler', () => {
  test.use({
    seed: {
      ...SEED,
      files: (d: Dirs) => {
        seedTask('away-run', 'acp:kimi', 'while the box is away')(d);
        seedTask('signed-out-run', 'claude', 'needs a sign-in')(d);
      },
    },
  });

  test('a run while the machine is away waits for it; a signed-out agent fails the run with the reason', async ({ harness }) => {
    const page = harness.page;
    // the machine is away when the time comes
    fs.writeFileSync(OFFLINE, '');
    const advance = (ms: number) => harness.app.evaluate((_, ms) => (globalThis as any).__schedulerAdvance(ms), ms);
    const runsOf = (id: string) => page.evaluate((id) => (window as any).native.automation.runs(id), id) as Promise<any[]>;
    await expect
      .poll(
        async () => {
          const done = (await runsOf('away-run')).some((r) => r.status === 'started');
          if (!done) await advance(61_000);
          return done;
        },
        { intervals: [4000], timeout: 60_000 },
      )
      .toBe(true);
    // the run's chat is listed like any Host chat, and its message waits for the machine
    const chatId = (await runsOf('away-run')).find((r) => r.status === 'started').chatId as string;
    expect(chatId).toMatch(/^acp:kimi:/);
    await page.getByRole('complementary').locator(`[data-sidebar-chat="${chatId}"]`).first().click();
    await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 60_000 });
    await shootBoth(page, harness.app, 'sched-run-waiting-for-host');
    // the machine is back: the message goes once and the run's reply streams in
    fs.rmSync(OFFLINE, { force: true });
    await expect(main(page).getByText('fake-host: while the box is away', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(calls().find((c) => c.method === 'chat.start')?.params).toMatchObject({ harness: 'acp:kimi', cwd: FOLDER });

    // Claude Code is signed out on the machine: that run failed, with the reason in the task's history
    await expect
      .poll(async () => (await runsOf('signed-out-run')).find((r) => r.status === 'failed')?.reason, { timeout: 30_000 })
      .toBe('Sign in to Claude Code on box.');
    await page.getByRole('button', { name: 'Scheduled' }).first().click();
    await page.locator('.sched-row', { hasText: 'signed-out-run' }).click();
    await expect(page.locator('.task-detail')).toContainText('Sign in to Claude Code on box.');
    await shootBoth(page, harness.app, 'sched-run-failed-signed-out');
  });
});
