// A machine chat the Host paused for lack of an answer: the sidebar shows the Host mark and Paused until Resume clears the attention. Both themes.
// e2e-covers: src/components/sidebar/ThreadRow.tsx src/components/sidebar/ThreadMachineLine.tsx src/components/ui/HostMark.tsx
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-attention-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const FAKE_SSH = path.join(__dirname, 'fixtures/fake-ssh');

const AGENTS = ['kimi', 'claude', 'codex'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [{ id: `${id}-remote-default`, name: `${id} Remote default`, default: true, efforts: ['low'], defaultEffort: 'low' }],
}));
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: AGENTS,
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

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
    MOPILOT_FLAGS: 'host.unattended=1',
    PATH: `${FAKE_SSH}:${process.env.PATH}`,
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});
test.setTimeout(240_000);
test.beforeEach(() => fs.rmSync(LOG, { force: true }));

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

test('a paused machine chat says so on its row and strip, and Resume sends "Continue."', async ({ harness }) => {
  const page = harness.page;
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();

  await composer(page).fill('pause-me');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const strip = page.locator('.host-away-strip');
  await expect(strip).toContainText('Paused: no answer in 30 min', { timeout: 45_000 });
  await expect(strip.getByRole('button', { name: 'Resume' })).toBeVisible();
  const row = page.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]').first();
  await expect(row.getByRole('img', { name: 'On box', exact: true })).toBeVisible();
  await expect(row.locator('.side-row-sub')).toHaveText('Paused');
  await shootBoth(page, harness.app, 'host-attention-paused');

  await strip.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => calls().some((c) => c.method === 'chat.send' && JSON.stringify(c.params).includes('Continue.'))).toBe(true);
  // the Host clears its attention when the message arrives: strip and row word go
  await expect(strip).toHaveCount(0, { timeout: 30_000 });
  await expect(row.locator('.side-row-sub')).toHaveCount(0);
  await expect(row.getByRole('img', { name: 'On box', exact: true })).toBeVisible();
  await shootBoth(page, harness.app, 'host-attention-resumed');
});
