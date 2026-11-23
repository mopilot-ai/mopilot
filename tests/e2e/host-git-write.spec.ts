// The Changes pane of a chat on a machine commits and discards through the machine's Host (#5050), in the real app against the fake `ssh` and a resident fake Host (fixtures/fake-ssh): the same Commit box, file ticks, "Discard changes" and "Discard all changes" as this Mac's pane, a file ticked off stays out of the commit, a refusal shows as the pane's own error, and the pane reads again after each write.
// e2e-covers: src/components/panels/SummaryRemoteRepo.tsx src/components/panels/SummaryChanges.tsx src/lib/hostRepo.ts
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-write-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const PATCH_FILE = path.join(ROOT, 'patch.diff');
const REFUSE = path.join(ROOT, 'refuse');
const PATCH = ['a.ts', 'b.ts', 'c.ts']
  .map((f) => [`diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1,2 @@', ' keep', `+added to ${f}`, ''].join('\n'))
  .join('');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const AGENTS = ['kimi', 'claude', 'codex'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [{ id: `${id}-remote-default`, name: `${id} Remote default`, default: true, efforts: ['low', 'high'], defaultEffort: 'low' }],
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
test.beforeEach(() => {
  fs.rmSync(LOG, { force: true });
  fs.rmSync(REFUSE, { force: true });
  fs.writeFileSync(PATCH_FILE, PATCH);
});
test.setTimeout(240_000);

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH_BIN],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_GIT_DIFF_FILE: PATCH_FILE,
    FAKE_HOST_GIT_WRITE_REFUSE: REFUSE,
    FAKE_HOST_GIT_STATUS: JSON.stringify({
      branch: 'feature/remote',
      head: 'a'.repeat(40),
      remote: null,
      truncated: false,
      files: ['a.ts', 'b.ts', 'c.ts'].map((p) => ({ path: p, added: 1, removed: 0 })),
    }),
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
    PATH: withPath([FAKE_SSH_BIN]),
  },
  seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
});

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];
const writes = () => calls().filter((c) => c.method === 'host.gitCommit' || c.method === 'host.gitDiscard');

test('a machine chat commits the ticked files and discards one file or all, as this Mac does', async ({ harness }) => {
  const page = harness.page;
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  // the listing has moved into the folder before it is taken, or the chat starts in its parent
  await expect(dialog.locator('.host-picker-path')).toContainText('/projects/app');
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await composer(page).fill('hello box');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.summary-row', { hasText: 'Branch changes' })).toContainText('3 files', { timeout: 45_000 });
  await page.locator('.summary-row', { hasText: 'Branch changes' }).click();
  const heads = page.locator('.cp-file-head');
  await expect(heads).toHaveCount(3, { timeout: 30_000 });
  // the commit box and ticks are the Uncommitted scope's
  await page.locator('.cp-scope').click();
  await page.getByRole('menuitemcheckbox', { name: 'Uncommitted changes' }).click();
  await expect(page.locator('.cp-file-pick')).toHaveCount(3);
  await shootBoth(page, harness.app, 'host-git-write-changes');

  // untick b.ts: the button says 2 of 3 and the commit names a.ts and c.ts only
  await page.getByLabel('Include b.ts in the commit').uncheck();
  await page.getByPlaceholder('Commit message').fill('two of three');
  await expect(page.locator('.cp-commit .btn')).toHaveText('Commit 2 of 3');
  await page.locator('.cp-commit .btn').click();
  await expect(heads).toHaveCount(1, { timeout: 30_000 });
  await expect(heads.first()).toContainText('b.ts');
  expect(writes().at(-1)).toMatchObject({
    method: 'host.gitCommit',
    params: { path: FOLDER, message: 'two of three', files: [{ path: 'a.ts' }, { path: 'c.ts' }] },
  });
  await shootBoth(page, harness.app, 'host-git-write-committed');

  // a refusal from the machine is shown as the pane's error and the message stays
  fs.writeFileSync(REFUSE, 'Resolve the conflicts first, then commit.');
  await page.getByLabel('Include b.ts in the commit').check();
  await page.getByPlaceholder('Commit message').fill('again');
  await page.locator('.cp-commit .btn').click();
  await expect(page.getByText('Resolve the conflicts first, then commit.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByPlaceholder('Commit message')).toHaveValue('again');
  await shootBoth(page, harness.app, 'host-git-write-refused');
  fs.rmSync(REFUSE);

  // discard: a file from its menu (asks first), then everything from the options menu
  fs.writeFileSync(PATCH_FILE, PATCH);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(heads).toHaveCount(3, { timeout: 30_000 });
  page.once('dialog', (d) => d.accept());
  await page.locator('.cp-file', { hasText: 'a.ts' }).getByLabel('File actions').click();
  await page.getByRole('menuitem', { name: 'Discard changes' }).click();
  await expect(heads).toHaveCount(2, { timeout: 30_000 });
  expect(writes().at(-1)).toMatchObject({ method: 'host.gitDiscard', params: { path: FOLDER, file: 'a.ts' } });
  await shootBoth(page, harness.app, 'host-git-write-discard-file');
  page.once('dialog', (d) => d.accept());
  await page.getByLabel('Changes options').click();
  await page.getByRole('menuitem', { name: 'Discard all changes' }).click();
  await expect(page.locator('.changes-pane')).toContainText('No changes', { timeout: 30_000 });
  expect(writes().at(-1)).toMatchObject({ method: 'host.gitDiscard', params: { path: FOLDER, file: null } });
  await shootBoth(page, harness.app, 'host-git-write-discard-all');
  expect(calls().filter((c) => c.method === 'host.gitCommit').length).toBe(2);
});
