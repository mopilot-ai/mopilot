// The second vocabulary of a Host chat in the real app (#3996, #3998, #4002): the chat's title and /goal arrive on the state lane, a command's output shows while it runs and is replaced by the finished call's, and a restarted app gets the state back from the Host's Hello. Against the resident fake Host (tests/e2e/fixtures/fake-ssh/host-chats.cjs), which tells them the way a Host with the `stream2` feature does.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-stream2-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')));
const SOCK = path.join(RESIDENT, 'h.sock');

const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: [{ id: 'kimi', detected: true, signedIn: true }],
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

const ENV = {
  MOPILOT_HOST_DEV: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_CHATS_SOCK: SOCK,
  FAKE_HOST_HARNESSES: JSON.stringify([{ id: 'kimi', detected: true, signedIn: true }]),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const main = (page: Page) => page.getByRole('main');
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
  // the folder the picker shows is the one "Use this folder" hands back
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
// a restart and a machine that drops take longer than a single turn
test.setTimeout(240_000);

/** What main reports as ignored (a failure it survives) goes to the test output, where a run on a runner can be read. */
const showIgnored = (harness: { app: { process(): NodeJS.Process | any } }) =>
  harness.app.process().stdout?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) if (line.includes('[ignored]')) console.log(line);
  });

test('a chat is titled, shows its goal and a running command’s output, and gets them back after an app restart', async ({ harness }) => {
  let page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'stream2 tour');
  // the title the Host told replaces the first prompt as the chat's name, and the goal it holds is shown
  const row = (p: Page) => p.getByRole('complementary').locator('[data-sidebar-chat^="acp:kimi:"]', { hasText: 'Stream tour' });
  await expect(row(page).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.goal-pill')).toBeVisible({ timeout: 45_000 });
  // a command's output is on its card while it runs (the finished call is 4 s away)
  await expect(stop(page)).toBeVisible();
  await main(page)
    .getByText(/Running ls/)
    .first()
    .click({ timeout: 30_000 });
  await expect(main(page)).toContainText('file-live.txt', { timeout: 30_000 });
  // the finished call replaces the live view, and the turn ends
  await expect(main(page).getByText('fake-host: stream2 tour', { exact: true })).toBeVisible({ timeout: 45_000 });
  await main(page)
    .getByRole('button', { name: /^Worked for/ })
    .click();
  await main(page).locator('button.step-row-hit[aria-expanded="false"]').first().click();
  await expect(main(page)).toContainText('file-done.txt');
  await expect(stop(page)).toHaveCount(0);
  // the app restarts: the Host's Hello brings the title and the goal back (the app kept no goal of its own)
  await harness.relaunch();
  page = harness.page;
  await row(page).first().click();
  await expect(page.locator('.goal-pill')).toBeVisible({ timeout: 45_000 });
  await expect(row(page).first()).toBeVisible();
});

test('an MCP server’s form question is a card in the chat, and the values go to the machine', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'elicit please');
  const card = page.locator('section.approval-card');
  await expect(card).toContainText('Who is asking?', { timeout: 45_000 });
  await card.getByLabel('Who').fill('Ada');
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(main(page).getByText('fake-host: elicit please', { exact: true })).toBeVisible({ timeout: 45_000 });
  const answered = (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).find((c) => c.method === 'chat.answer');
  expect(answered?.params.form).toEqual({ action: 'accept', content: { who: 'Ada' } });
  // the card stays as the receipt, and says the machine's Host took the answer (#4694), not that the receipt is unconfirmed
  await expect(card).toContainText('Answered.');
  await expect(card).not.toContainText('Receipt is not confirmed');
});

test('a compaction the machine tells is recorded and the chat goes on', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'compact now');
  await expect(main(page).getByText('fake-host: compact now', { exact: true })).toBeVisible({ timeout: 45_000 });
  await send(page, 'and again');
  await expect(main(page).getByText('fake-host: and again', { exact: true })).toBeVisible({ timeout: 45_000 });
});

test('a turn the machine\u2019s restart cut off says what it interrupted and offers Retry, which sends the message again to the same chat', async ({
  harness,
}) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'cutoff please');
  await expect(main(page)).toContainText('The machine restarted during this turn. Interrupted: sleep 45.', { timeout: 45_000 });
  await expect(stop(page)).toHaveCount(0);
  const sends = () =>
    (readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[]).filter(
      (c) => (c.method === 'chat.start' || c.method === 'chat.send') && c.params.text === 'cutoff please',
    );
  expect(sends().length).toBe(1);
  await main(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(main(page).getByText('fake-host: cutoff please', { exact: true })).toBeVisible({ timeout: 45_000 });
  // one more send of the same words, to the same chat on the machine
  expect(sends().length).toBe(2);
  expect(new Set(sends().map((c) => c.params.chatId)).size).toBe(1);
});
