// A chat started on a machine and run there, in the real app (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1), against the fake `ssh` that serves the Host protocol on the forwarded socket and a resident fake Host (fixtures/fake-ssh/host-chats.cjs) that keeps chats running while the app and the tunnel come and go:
// e2e-covers: src/session/open.ts src/lib/paths.ts src/components/markdown/Markdown.tsx
// pick a folder on the machine and send: the first message starts the chat there, its reply streams into the chat view, Stop ends a running turn, a permission card is answered on the machine; then the app restarts mid-run and the chat catches up, and the machine drops while a message is sent (Waiting for host) and comes back (sent once, in order);
// a card nobody answers pauses the run on the third timeout (the timeout is shortened for the spec), and the machine is told to stop it.
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/SummaryEnvironment.tsx src/lib/hostRepo.ts src/store/sideChat.ts src/session/composerAttach.ts
// e2e-covers: src/components/sidebar/repositoryGroups.ts src/components/sidebar/ProjectGroup.tsx src/store/repositoryDraft.ts
// e2e-covers: src/components/composer/ContextRing.tsx src/components/context/ContextSummary.tsx
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { withPath } from './fixtures/nodeCommand';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';
import { AGENT_LABEL, pickMachineModel, testHostUsageRing } from './fixtures/hostComposer';
import { selectCompletedReply } from './fixtures/replySelection';
import { parseUserText } from '../../shared/userText.mjs';

// a basic harness is admitted only with sage-mcp, which builds only on macOS (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-chat-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
fs.mkdirSync(path.join(FOLDER, 'src'));
fs.writeFileSync(path.join(FOLDER, 'README.md'), '# remote readme\nread through the Host\n');
fs.writeFileSync(path.join(FOLDER, 'src', 'index.ts'), 'export const where = "on the machine";\n');
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
const CONTEXT_RELEASE = path.join(ROOT, 'context-release');
// a unix socket path is short: the resident Host's lives in the temp folder itself
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')));
const SOCK = path.join(RESIDENT, 'h.sock');

const MACHINE_AGENTS = ['kimi', 'claude', 'codex'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [
    { id: `${id}-remote-default`, name: `${id} Remote default`, default: true, efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: `${id}-remote-other`, name: `${id} Remote other`, default: false, efforts: ['low', 'high'], defaultEffort: 'low' },
  ],
}));
const MACHINE = {
  id: 'ssh:me@box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  capabilities: { shell: true },
  harnesses: MACHINE_AGENTS,
  // read when the registry file is written, not when the worker loads this file: a spec late in a shard would seed a heartbeat older than the 90 s the registry calls online (#3548)
  get lastHeartbeat() {
    return Date.now();
  },
  setup: '',
};

let resident: ChildProcess | null = null;
test.beforeAll(async () => {
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: SOCK, FAKE_HOST_LOG: LOG, FAKE_HOST_CONTEXT_RELEASE: CONTEXT_RELEASE },
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
  FAKE_HOST_SIDE_CHATS: '1',
  FAKE_HOST_ROOT: ROOT,
  FAKE_HOST_LOG: LOG,
  FAKE_HOST_OFFLINE: OFFLINE,
  FAKE_HOST_GIT_DIFF: [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old line',
    '+new line',
    '+added line',
    '',
  ].join('\n'),
  FAKE_HOST_GIT_STATUS: JSON.stringify({
    branch: 'feature/remote',
    head: 'a'.repeat(40),
    remote: null,
    truncated: false,
    files: [
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'notes.md', added: 1, removed: 0 },
    ],
  }),
  FAKE_HOST_CHATS_SOCK: SOCK,
  FAKE_HOST_HARNESSES: JSON.stringify(MACHINE_AGENTS),
  PATH: withPath([FAKE_SSH_BIN]),
};
const SEED = { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } };
test.use({ harnesses: 'codex', acp: { kimi: {} }, shellPath: [FAKE_SSH_BIN], env: ENV, seed: SEED });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const main = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Pick Kimi Code and the folder on the machine, as the new chat's target. */
async function pickTarget(page: Page, folder = FOLDER) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(path.join(ROOT, 'projects'));
  const name = path.basename(folder);
  await dialog.locator('.host-picker-open', { hasText: name }).click();
  // the folder the picker shows is the one "Use this folder" hands back
  await expect(dialog.locator('.host-picker-path')).toHaveText(folder);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // the project chip names only the folder; the Run on chip beside it names the machine
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveText(name);
  await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', `Change project: ${name} · box`);
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

test('a reply on a machine can open a side chat or attach its quote to the original chat', async ({ page }) => {
  await pickTarget(page);
  await send(page, 'show the retry loop');
  const reply = 'fake-host: show the retry loop';
  await expect(main(page).getByText(reply, { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(stop(page)).toHaveCount(0);
  const parent = calls().find((c) => c.method === 'chat.start')!.params.chatId;

  await selectCompletedReply(page, reply);
  await page.locator('.selection-toolbar').getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(main(page).locator('.selection-chip')).toContainText('1 annotation');
  const question = 'explain the quote in this chat';
  await send(page, question);
  const quotedSend = () => calls().find((c) => c.method === 'chat.send' && c.params.text?.includes(question));
  await expect.poll(quotedSend).toBeTruthy();
  const sent = quotedSend()!.params;
  expect(sent.chatId).toBe(parent);
  expect(parseUserText(sent.text).annotations[0].text).toBe(reply);

  // Select the original assistant reply even after a later user turn includes the same text as a quote.
  await selectCompletedReply(page, reply);
  await page.locator('.selection-toolbar').getByRole('button', { name: 'Start a side chat' }).click();
  const side = page.locator('.side-pane');
  await expect(side.locator('.selection-chip')).toContainText('1 selection');
  await side.getByRole('textbox', { name: 'Message', exact: true }).fill('ask in the side chat');
  await side.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(side.getByText(/fake-host:.*ask in the side chat/s)).toBeVisible({ timeout: 30_000 });
  const start = calls().find((c) => c.method === 'chat.start' && c.params.sideChat)?.params;
  expect(start).toMatchObject({ harness: 'acp:kimi', cwd: FOLDER, sideChat: { sourceId: parent, epoch: 0 } });
  expect(start!.chatId).not.toBe(parent);
  expect(parseUserText(start!.text).selections).toEqual([reply]);
});

test('a chat starts on the machine, streams its reply, stops, and has a permission card answered there', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'hello box');
  await expect(main(page).getByText('fake-host: hello box', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(stop(page)).toHaveCount(0);
  // the machine was asked to start the chat in the folder picked on it, on the agent picked here, and nothing ran on this Mac
  const start = calls().find((c) => c.method === 'chat.start');
  expect(start?.params).toMatchObject({ harness: 'acp:kimi', cwd: FOLDER });
  expect(harness.acpLog('kimi').some((l) => l.kind === 'in' && l.msg.method === 'session/prompt')).toBe(false);
  // the summary shows the machine's own branch and changes, read by its Host, not this Mac's git
  await expect(page.locator('.summary-branch')).toHaveText('feature/remote', { timeout: 30_000 });
  await expect(page.locator('.summary-row', { hasText: 'Branch changes' })).toContainText('2 files');
  await expect(page.locator('.summary-row', { hasText: 'Branch changes' }).locator('.diff-stat')).toHaveText('+4 -1');
  expect(calls().some((c) => c.method === 'git.status' && c.params.path === FOLDER)).toBe(true);
  await shootBoth(page, harness.app, 'host-chat-summary');
  // the Changes pane reads the machine's patch through its Host: the summary's row opens it
  await page.locator('.summary-row', { hasText: 'Branch changes' }).click();
  await expect(page.locator('.cp-file-head')).toContainText('a.ts', { timeout: 30_000 });
  await expect(page.locator('.changes-pane')).toContainText('added line');
  expect(calls().some((c) => c.method === 'git.diff' && c.params.path === FOLDER)).toBe(true);
  await shootBoth(page, harness.app, 'host-chat-changes');
  // the Files pane reads the machine's folder through its Host: the tree, then a file as read-only text
  await harness.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'Toggle Navigation Panel') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  await expect(page.locator('.files-tree-title')).toHaveText('app', { timeout: 30_000 });
  await expect(page.locator('.files-tree .file-node-name')).toHaveText(['src', 'README.md']);
  await page.locator('.files-tree .file-node', { hasText: 'README.md' }).click();
  await expect(page.locator('.remote-file-text')).toContainText('read through the Host');
  expect(calls().some((c) => c.method === 'fs.read' && c.params.path === path.join(FOLDER, 'README.md'))).toBe(true);
  await shootBoth(page, harness.app, 'host-chat-files');
  // the @ list searches the machine's folder through its Host, never this Mac's
  await composer(page).fill('@READ');
  await expect(page.locator('.composer-popup')).toContainText('README.md', { timeout: 30_000 });
  expect(calls().some((c) => c.method === 'fs.search' && c.params.path === FOLDER && c.params.query === 'READ')).toBe(true);
  await shootBoth(page, harness.app, 'host-chat-mention');
  await composer(page).fill('');
  // the machine's folder opens nothing on this Mac: the chat menu keeps Open in as in a chat here, but its one item is greyed and says where the folder is
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move to right pane' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Open in', exact: true }).hover();
  await expect(page.getByRole('menuitem', { name: /^Open folder/ })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Move to right pane' }).hover();
  await shootBoth(page, harness.app, 'host-chat-menu');
  await page.keyboard.press('Escape');

  // Stop reaches the machine and the turn ends as stopped
  await send(page, 'slow work');
  await expect(stop(page)).toBeVisible({ timeout: 30_000 });
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  expect(calls().some((c) => c.method === 'chat.stop')).toBe(true);

  // a permission card is the machine's: answering it gives the machine the option picked, and the reply follows
  await send(page, 'approve this');
  const card = page.locator('.approval-card');
  await expect(card).toContainText('wants to: Run ls', { timeout: 30_000 });
  await page.keyboard.press('1');
  await expect(main(page).getByText('fake-host: approve this', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(calls().find((c) => c.method === 'chat.answer')?.params).toMatchObject({ optionId: 'allow' });
  await expect(card).toHaveCount(0);
});

test('a turn that fails on the machine says why, and the chat stays usable', async ({ harness }) => {
  const page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'limit');
  // the Host sends the error as an object: read as text, it is the usage-limit note, not "Something went wrong in this chat"
  await expect(
    main(page)
      .getByText(/reached its usage limit/)
      .first(),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Something went wrong in this chat')).toHaveCount(0);
  await send(page, 'still here');
  await expect(main(page).getByText('fake-host: still here', { exact: true })).toBeVisible({ timeout: 45_000 });
});

test('a Markdown result link previews the file in a remote worktree with a literal percent escape', async ({ page }) => {
  const folder = path.join(ROOT, 'projects', 'mopilot%2f03a201f8');
  const file = path.join(folder, 'host.md');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, '# Remote result\nFile contents from the Host\n');

  await pickTarget(page, folder);
  await send(page, `[Remote result](${file}:2)`);
  await main(page).getByRole('link', { name: 'Remote result', exact: true }).click({ timeout: 45_000 });
  await expect(page.locator('.remote-file-hit')).toHaveText('File contents from the Host');
  expect(calls().find((c) => c.method === 'fs.read')?.params.path).toBe(file);
});

test('the app restarts while the machine runs a turn, and the chat catches up; the machine drops and a message waits for it', async ({
  harness,
}) => {
  let page = harness.page;
  showIgnored(harness);
  await pickTarget(page);
  await send(page, 'first');
  await expect(main(page).getByText('fake-host: first', { exact: true })).toBeVisible({ timeout: 45_000 });
  // a turn that keeps running on the machine across the app's restart
  await send(page, 'slow forever');
  await expect(stop(page)).toBeVisible({ timeout: 30_000 });
  await harness.relaunch();
  page = harness.page;
  await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:kimi:"]', { hasText: 'first' }).first().click();
  // its history is back from this Mac's copy, and the turn still running there is shown as running
  await expect(main(page).getByText('fake-host: first', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(stop(page)).toBeVisible({ timeout: 45_000 });
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });

  // the machine drops: a message is kept and shown as waiting, then sent once when the machine is back
  fs.writeFileSync(OFFLINE, '');
  await send(page, 'while away');
  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 60_000 });
  // the summary's machine chip names the machine the chat runs on
  await expect(page.locator('.summary-machine .summary-label')).toHaveText('box');
  await shootBoth(page, harness.app, 'waiting-for-host');
  // before the registry calls it offline (a beat missed, under 90 s) the strip says the link is reconnecting, not nothing and not offline (audit chat:C22)
  await expect(page.locator('.host-away-strip .fa-title')).toHaveText('Reconnecting to box…', { timeout: 90_000 });
  // once the machine reads offline the chat says so in one line, its permission mode is shown as not changeable, and the summary panel names the machine instead of reading this Mac's branch and changes
  // (the strip says what the machine's row says, "box · Offline · …", with the row's Check again: audit chat:C21)
  await expect(page.locator('.host-away-strip .fa-title')).toContainText('box · Offline', { timeout: 120_000 });
  await expect(page.locator('.host-away-strip').getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.locator('.host-mode-chip')).toHaveText('Set on box');
  await expect(page.locator('.host-mode-chip')).toBeDisabled();
  await expect(page.locator('.machine-folder-note')).toHaveText("Branch and changes aren't available while box is offline.");
  await shootBoth(page, harness.app, 'host-chat-offline');
  fs.rmSync(OFFLINE, { force: true });
  await expect(main(page).getByText('fake-host: while away', { exact: true })).toBeVisible({ timeout: 90_000 });
  // once means one input, not one request: a send whose reply was lost stays queued (remoteSend drainChat) and goes again
  // under its key when the machine is back (resume), and the Host replays its first answer
  const sends = calls().filter((c) => c.method === 'chat.send' && c.params.text === 'while away');
  expect(sends.length).toBeGreaterThan(0);
  expect(sends.every((c) => typeof c.params.key === 'string' && c.params.key.length > 0)).toBe(true);
  expect(new Set(sends.map((c) => c.params.key)).size).toBe(1);
  await expect(main(page).getByText('fake-host: while away', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Waiting for host')).toHaveCount(0);
});

// the unanswered-card period is 10 minutes in the app; an unpackaged build takes it from MOPILOT_HOST_APPROVAL_MS
test.describe('a card nobody answers', () => {
  test.use({
    env: { ...ENV, MOPILOT_HOST_APPROVAL_MS: '2000' },
    seed: { ...SEED, uiState: { prefs: { notifyOnComplete: 'always' } } },
  });

  test('three timeouts pause the run: the machine is told to stop it and the user is told it was paused', async ({ harness }) => {
    const page = harness.page;
    showIgnored(harness);
    await harness.app.evaluate(({ Notification }) => {
      (globalThis as any).__shown = [];
      Notification.prototype.show = function (this: any) {
        (globalThis as any).__shown.push(this.title);
      };
    });
    const shown = () => harness.app.evaluate(() => (globalThis as any).__shown as string[]);
    await pickTarget(page);
    await send(page, 'approve this');
    await expect(page.locator('.approval-card')).toContainText('wants to: Run ls', { timeout: 30_000 });
    // nobody answers: the third period without an answer pauses the run
    await expect.poll(shown, { timeout: 30_000 }).toContain('Run paused: no one answered its approvals');
    expect(calls().some((c) => c.method === 'chat.stop')).toBe(true);
    // the run was stopped on the machine, so the card is gone and the turn is over
    await expect(page.locator('.approval-card')).toHaveCount(0, { timeout: 30_000 });
    await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });
    expect(calls().some((c) => c.method === 'chat.answer')).toBe(false);
  });
});

testHostUsageRing(test, { pickTarget, send, calls, releaseFile: CONTEXT_RELEASE });

for (const agent of ['kimi', 'claude', 'codex']) {
  test(`machine composer picks ${agent} model and effort for new and started chats`, async ({ harness }) => {
    const page = harness.page;
    await pickTarget(page);
    await pickMachineModel(page, agent);
    await expect(page.locator('.effort-pop')).toBeVisible();
    await page.locator('.effort-pop').press('ArrowRight');
    await shootBoth(page, harness.app, `host-${agent}-model-effort`);
    await page.keyboard.press('Escape');
    if (agent !== 'kimi') {
      await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
      await expect(page.locator('.perm-list [role=menuitemradio]')).toHaveCount(4);
      await shootBoth(page, harness.app, `host-${agent}-permissions`);
      await page.locator('.perm-item.read-only').click();
    }
    await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    const plan = page.locator('.add-panel-item').filter({ has: page.getByText('Plan mode', { exact: true }) });
    await expect(plan).toHaveAttribute('aria-disabled', 'true');
    await expect(plan).toContainText("Plan mode isn't available on box yet.");
    await shootBoth(page, harness.app, `host-${agent}-plan-unavailable`);
    await expect(page.locator('.add-panel-item').filter({ has: page.getByText('Files and folders', { exact: true }) })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    for (const name of ['Computer History', 'Record a skill']) {
      const item = page.locator('.add-panel-item').filter({ has: page.getByText(name, { exact: true }) });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText('Only images');
    }
    await shootBoth(page, harness.app, `host-${agent}-images-and-files`);
    await page.keyboard.press('Escape');
    await send(page, `model-pick-${agent}`);
    await expect(main(page).getByText(`fake-host: model-pick-${agent}`, { exact: true })).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    await expect(plan).toHaveAttribute('aria-disabled', 'true');
    await shootBoth(page, harness.app, `host-${agent}-started-plan-unavailable`);
    await expect(page.locator('.add-panel-item').filter({ has: page.getByText('Files and folders', { exact: true }) })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await shootBoth(page, harness.app, `host-${agent}-started-images-and-files`);
    await page.keyboard.press('Escape');
    const start = calls().find((c) => c.method === 'chat.start');
    expect(start?.params).toMatchObject({ model: `${agent}-remote-other`, effort: 'high' });
    if (agent !== 'kimi') expect(start?.params.permission).toBe('read-only');
    await expect(page.getByRole('button', { name: 'Select model', exact: true })).toContainText(`${agent} Remote other`);
    await page.getByRole('button', { name: 'Select model', exact: true }).click();
    await page.getByRole('button', { name: 'Select harness and model', exact: true }).click();
    // a started chat's picker offers each of the machine's agents with its two models beside it, a pick of one of another agent's moves the chat there (#4755)
    await expect(page.locator('.hp-row')).toHaveCount(3);
    for (const other of ['kimi', 'claude', 'codex']) {
      await page.locator('.hp-row', { hasText: AGENT_LABEL[other] }).hover();
      await expect(page.getByRole('menuitemradio')).toHaveCount(2);
      for (const model of ['default', 'other'])
        await expect(page.getByRole('menuitemradio', { name: new RegExp(`^${other} Remote ${model}( Default)?$`) })).toBeVisible();
    }
    await page.locator('.hp-row', { hasText: AGENT_LABEL[agent] }).hover();
    // the default model's row carries a "Default" tag in its name
    await page.getByRole('menuitemradio', { name: new RegExp(`^${agent} Remote default( Default)?$`) }).click();
    await page.locator('.effort-pop').press('ArrowLeft');
    await page.keyboard.press('Escape');
    if (agent !== 'kimi') {
      await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
      await page.locator('.perm-item.full-access').click();
    }
    await send(page, `changed-pick-${agent}`);
    await expect(main(page).getByText(`fake-host: changed-pick-${agent}`, { exact: true })).toBeVisible({ timeout: 45_000 });
    const sent = calls().find((c) => c.method === 'chat.send' && c.params.text === `changed-pick-${agent}`);
    expect(sent?.params).toMatchObject({ model: `${agent}-remote-default`, effort: 'low' });
    if (agent !== 'kimi') expect(calls().some((c) => c.method === 'chat.permit' && c.params.value === 'full-access')).toBe(true);
    await shootBoth(page, harness.app, `host-${agent}-changed-model`);
  });
}

test.describe('a project across execution locations', () => {
  test.use({
    env: { ...ENV, FAKE_HOST_REPO: JSON.stringify({ remote: 'git@github.com:example/app.git' }) },
    mainRequire: [path.resolve('tests/e2e/fixtures/sidebar-cloud-tasks.cjs')],
    seed: {
      ...SEED,
      codexThreads: [
        { id: '019b0000-0000-7000-8000-000000000081', cwd: 'projects/local-app', name: 'Local sidebar chat', turns: ['local'] },
      ],
      files: (directories) => {
        const local = path.join(directories.home, 'projects/local-app');
        fs.mkdirSync(local, { recursive: true });
        execFileSync('git', ['init', local]);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/app.git'], { cwd: local });
        fs.writeFileSync(
          path.join(directories.userData, 'projects.json'),
          JSON.stringify({ projects: [{ id: 'sidebar-project', name: 'Shared project', path: local }] }),
        );
      },
    },
  });

  test('local, machine and Codex Cloud rows open from one project and its composer can pick the machine checkout', async ({ page }) => {
    await pickTarget(page);
    await send(page, 'Machine sidebar chat');
    await expect(main(page).getByText('fake-host: Machine sidebar chat', { exact: true })).toBeVisible({ timeout: 45_000 });
    const group = page.locator('.project-group').filter({ has: page.locator('.project-row[aria-label="Shared project"]') });
    await expect(group.locator('.thread-row')).toHaveCount(3, { timeout: 45_000 });
    const projectRow = group.locator('.project-row');
    await expect(projectRow.locator('.host-mark .lucide-cloud')).toBeVisible();
    await expect(projectRow.locator('.host-mark .lucide-square-terminal')).toBeVisible();
    await expect(projectRow.locator('.host-mark + .project-disclosure')).toBeVisible();
    await group.locator('[data-sidebar-cloud="task_sidebar"]').click();
    await expect(page.locator('.cloud-title')).toHaveText('Cloud sidebar task');
    await group.locator('.thread-row', { hasText: 'Local sidebar chat' }).click();
    await expect(main(page)).toContainText('local');
    await group.locator('.thread-row', { hasText: 'Machine sidebar chat' }).click();
    await expect(main(page)).toContainText('fake-host: Machine sidebar chat');

    await group.locator('.project-row').hover();
    await group.getByRole('button', { name: 'New chat in Shared project' }).click();
    const location = page.getByRole('button', { name: 'Work in', exact: true });
    await expect(location).toContainText('This computer');
    await location.click();
    await page.locator('.menu-item', { hasText: 'box' }).click();
    await send(page, 'Second machine sidebar chat');
    await expect(main(page)).toContainText('fake-host: Second machine sidebar chat', { timeout: 45_000 });
    expect(calls().find((call) => call.method === 'chat.start' && call.params.text === 'Second machine sidebar chat')?.params.cwd).toBe(
      FOLDER,
    );
  });
});
