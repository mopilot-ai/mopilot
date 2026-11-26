// The sidebar organized By machine (#5576): a machine's group lists every chat its Host holds, the ones this Mac started and the ones another client started there, five and Show more; a chat that is running there shows its dot, opens in the one chat view with its live state, and continues on that machine; a machine that does not answer says so, and a chat deleted here does not come back from it. A fake resident Host that lists and watches its chats. Both themes.
// e2e-covers: src/components/sidebar/MachineGroups.tsx src/components/sidebar/MachineChatRow.tsx src/components/sidebar/machineGroupData.ts src/lib/hostChatIndex.ts src/session/openMachineChat.ts
import fs from 'node:fs';
import { once } from 'node:events';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import type { Page } from '@playwright/test';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { shootBoth } from './fixtures/shoot';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-by-machine-e2e-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const LOG = path.join(ROOT, 'host-calls.log');
const OFFLINE = path.join(ROOT, 'offline');
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hbm-')));
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
test.beforeEach(() => fs.rmSync(OFFLINE, { force: true }));
// what the Host was asked and what the sidebar said, kept with a failure
test.afterEach(async ({ harness }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const asked = (fs.existsSync(LOG) ? (readJsonLineLog(LOG) as { method: string }[]) : []).map((c) => c.method);
  await testInfo.attach('host-asked', { body: [...new Set(asked)].join('\n') + `\n${asked.length} calls`, contentType: 'text/plain' });
  await testInfo.attach('sidebar', {
    body: await harness.page
      .locator('.sidebar')
      .innerText()
      .catch(() => 'no sidebar'),
    contentType: 'text/plain',
  });
});

test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  shellPath: [FAKE_SSH],
  env: {
    MOPILOT_HOST_DEV: '1',
    FAKE_HOST_ROOT: ROOT,
    FAKE_HOST_LOG: LOG,
    FAKE_HOST_OFFLINE: OFFLINE,
    FAKE_HOST_CHATS_SOCK: SOCK,
    FAKE_HOST_CHAT_LIST: '1',
    FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
    PATH: `${FAKE_SSH}:${process.env.PATH}`,
  },
  seed: {
    uiState: { prefs: { theme: 'system', sidebarOrganize: 'machine' } },
    userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } },
  },
});
test.setTimeout(420_000);

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const calls = () => readJsonLineLog(LOG) as { method: string; params: Record<string, any> }[];

/** One request to the resident Host's own socket, as a client it has never seen: `fake.seed` starts a chat there, `chat.stop` ends its turn. */
async function asAnotherClient(method: string, params: Record<string, unknown>) {
  const socket = await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 10_000 });
  socket.setEncoding('utf8');
  socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  const [reply] = await once(socket, 'data');
  socket.destroy();
  return JSON.parse(String(reply).split('\n')[0]);
}
const seed = (chatId: string, title: string, text: string) =>
  asAnotherClient('fake.seed', { chatId, title, folder: FOLDER, startedBy: 'the Mini', text });

test('By machine lists what a machine holds; a chat that runs there shows its dot, opens live in the chat view and its turn ending there ends it here; a chat opened from the machine continues on it', async ({
  harness,
}) => {
  const page = harness.page;
  const sidebar = page.locator('.sidebar');
  const group = sidebar.locator('[data-machine-group="ssh:me@box"]');
  await expect(sidebar.locator('.side-label', { hasText: 'Machines' })).toBeVisible({ timeout: 45_000 });
  await expect(sidebar.locator('[data-machine-group="this-mac"]')).toBeVisible();
  await expect(group.locator('.by-machine-dot.on')).toBeVisible({ timeout: 45_000 });
  await expect(group.locator('.empty-note')).toHaveText('No chats', { timeout: 45_000 });

  // a chat this Mac starts on the machine
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText('Folder on box…').click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
  await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
  await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await composer(page).fill('started on this Mac');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(group.locator('[data-sidebar-chat^="acp:"]')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.getByText('fake-host: started on this Mac')).toBeVisible({ timeout: 45_000 });

  // the Mac's own chat is not the open one while the others are counted: an open chat is always drawn
  await sidebar.getByText('New chat', { exact: true }).first().click();
  // chats another client started on the machine reach the list without this Mac having a record of them; the last one keeps running
  for (let n = 1; n <= 5; n++) await seed(`acp:kimi:seed-${n}`, `Started on the machine ${n}`, `seed ${n}`);
  await seed('acp:kimi:seed-6', 'Started on the machine 6', 'slow job');
  // seven chats, the newest five shown: the machine's own five newest, then Show more for this Mac's first chat and the first of the machine's
  await expect(group.locator('.machine-chat-row')).toHaveCount(5, { timeout: 45_000 });
  await expect(group.locator('.show-more')).toHaveText('Show 2 more');
  const running = group.locator('.machine-chat-row', { hasText: 'Started on the machine 6' });
  await expect(running.locator('.row-dot.working')).toBeVisible();
  await shootBoth(page, harness.app, 'host-by-machine');

  await group.locator('.show-more').click();
  await expect(group.locator('.machine-chat-row')).toHaveCount(6);
  await expect(group.locator('[data-sidebar-chat^="acp:"]')).toHaveCount(1);

  // a chat running on the machine opens in the chat view with its live state, and its turn ending there ends it here
  await running.click();
  const row6 = group.locator('[data-sidebar-chat="acp:kimi:seed-6"]');
  await expect(row6).toHaveAttribute('aria-current', 'page', { timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(row6.locator('.row-dot.working')).toBeVisible();
  await asAnotherClient('chat.stop', { chatId: 'acp:kimi:seed-6' });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 45_000 });
  await expect(row6.locator('.row-dot.working')).toHaveCount(0, { timeout: 45_000 });

  // a chat that is only the machine's opens as every chat does, and a message sent in it runs on that machine, in that chat
  await group.locator('.machine-chat-row', { hasText: 'Started on the machine 2' }).click();
  await expect(page.getByText('fake-host: seed 2')).toBeVisible({ timeout: 45_000 });
  await composer(page).fill('go on from the Mac');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('fake-host: go on from the Mac')).toBeVisible({ timeout: 45_000 });
  const sent = calls().filter((c) => c.method === 'chat.send' && JSON.stringify(c.params).includes('go on from the Mac'));
  expect(sent.map((c) => c.params.chatId)).toEqual(['acp:kimi:seed-2']);
});

test('the machine heading starts a chat on the machine and opens its settings', async ({ harness }) => {
  const page = harness.page;
  const group = page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  await expect(group.locator('.by-machine-dot.on')).toBeVisible({ timeout: 45_000 });
  await group.locator('.project-row').hover();
  await group.getByRole('button', { name: 'New chat on box' }).click();
  await expect(page.locator('.ctxbar')).toContainText('box', { timeout: 15_000 });
  await group.locator('.project-row').hover();
  await group.getByRole('button', { name: 'Actions for box' }).click();
  await page.getByRole('menuitem', { name: 'Edit machine…' }).click();
  await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible({ timeout: 15_000 });
});

test('a machine that does not answer: its chats are the last it said, opening one says why and where to fix it, and a chat deleted here does not come back', async ({
  harness,
}) => {
  const page = harness.page;
  const group = page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  for (const n of [1, 2]) await seed(`acp:kimi:away-${n}`, `Away chat ${n}`, `away ${n}`);
  await expect(group.locator('.machine-chat-row', { hasText: 'Away chat 1' })).toBeVisible({ timeout: 60_000 });
  // one of them is taken in while the machine answers
  await group.locator('.machine-chat-row', { hasText: 'Away chat 1' }).click();
  await expect(group.locator('[data-sidebar-chat="acp:kimi:away-1"]')).toBeVisible({ timeout: 45_000 });

  fs.writeFileSync(OFFLINE, '');
  await expect(group.locator('.by-machine-dot.off')).toBeVisible({ timeout: 180_000 });
  await expect(group.locator('.empty-note').first()).toContainText('Offline', { timeout: 30_000 });
  const second = group.locator('.machine-chat-row', { hasText: 'Away chat 2' });
  await expect(second).toHaveClass(/not-live/);
  await second.click();
  await expect(page.getByText(/box is offline\. Reconnect it to open this chat/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit machine' })).toBeVisible();
  await shootBoth(page, harness.app, 'host-by-machine-offline');

  // deleted here while the machine is away: the machine still lists it, and it does not come back as a row
  const taken = group.locator('[data-sidebar-chat="acp:kimi:away-1"]');
  await taken.hover();
  await taken.getByRole('button', { name: 'More options', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect(taken).toHaveCount(0, { timeout: 30_000 });
  await expect(group.locator('.machine-chat-row', { hasText: 'Away chat 1' })).toHaveCount(0);
  await page.waitForTimeout(2_000);
  await expect(group.locator('.machine-chat-row', { hasText: 'Away chat 1' })).toHaveCount(0);

  // the app starts again while the machine is still away, and then the machine answers: the deletion waits in the outbox the whole time,
  // so the chat the machine still lists is not a row at any point, and the machine is told to delete it
  await harness.relaunch();
  const again = harness.page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  await expect(again).toBeVisible({ timeout: 60_000 });
  fs.rmSync(OFFLINE, { force: true });
  await expect(again.locator('.by-machine-dot.on')).toBeVisible({ timeout: 180_000 });
  await expect(again.locator('.machine-chat-row', { hasText: 'Away chat 2' })).toBeVisible({ timeout: 60_000 });
  await expect(again.locator('.machine-chat-row', { hasText: 'Away chat 1' })).toHaveCount(0);
  await expect
    .poll(() => calls().some((c) => c.method === 'chat.remove' && c.params.chatId === 'acp:kimi:away-1'), { timeout: 60_000 })
    .toBe(true);
  await expect(again.locator('.machine-chat-row', { hasText: 'Away chat 1' })).toHaveCount(0);
});

test('a Claude Code chat and a Codex chat of the machine open as their own family and continue on the machine; a message sent while the chat runs there waits for its turn', async ({
  harness,
}) => {
  const page = harness.page;
  const group = page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  await expect(group.locator('.by-machine-dot.on')).toBeVisible({ timeout: 45_000 });
  await seed('claude:fam-claude', 'Claude chat on the machine', 'family claude');
  await seed('fam-codex-uuid', 'Codex chat on the machine', 'family codex');
  for (const [title, sentText, hostChat, bumped] of [
    ['Claude chat on the machine', 'next from the Mac (claude)', 'claude:fam-claude', true],
    ['Codex chat on the machine', 'next from the Mac (codex)', 'fam-codex-uuid', false],
  ] as const) {
    await group.locator('.machine-chat-row', { hasText: title }).click({ timeout: 60_000 });
    await expect(page.getByText(/fake-host: family (claude|codex)/)).toBeVisible({ timeout: 45_000 });
    // another client continues the chat between the open and the send: the Host holds the next epoch
    if (bumped) await asAnotherClient('fake.bump', { chatId: hostChat });
    await composer(page).fill(sentText);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(`fake-host: ${sentText}`)).toBeVisible({ timeout: 60_000 });
    // the Host got it as its own id of that family, carrying the epoch it holds for the chat (a Host refuses another): the one the
    // chat was taken in with, or the next one read again from the list after a refusal
    const sent = calls().filter((c) => c.method === 'chat.send' && JSON.stringify(c.params).includes(sentText));
    expect(sent.map((c) => [c.params.chatId, c.params.epoch]).at(-1)).toEqual([hostChat, bumped ? 4 : 3]);
  }
  // no mode of this Mac's making rides with a chat that already runs there: the machine keeps the one it reports
  expect(calls().filter((c) => c.method === 'chat.permit' && ['claude:fam-claude', 'fam-codex-uuid'].includes(c.params.chatId))).toEqual(
    [],
  );

  // the app starts again: the chat is still one taken in from the machine's list (its binding says so), so no mode of this Mac's is set on the
  // machine, and a Host that moved on to the next epoch meanwhile is followed
  await harness.relaunch();
  const again = harness.page;
  const row = again.locator('.sidebar [data-sidebar-chat="acp:host-claude:fam-claude"]');
  await expect(row).toBeVisible({ timeout: 90_000 });
  await row.click();
  await asAnotherClient('fake.bump', { chatId: 'claude:fam-claude' });
  await composer(again).fill('after the restart');
  await again.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(again.getByText('fake-host: after the restart')).toBeVisible({ timeout: 60_000 });
  const last = calls()
    .filter((c) => c.method === 'chat.send' && JSON.stringify(c.params).includes('after the restart'))
    .at(-1);
  expect([last?.params.chatId, last?.params.epoch]).toEqual(['claude:fam-claude', 5]);
  expect(calls().filter((c) => c.method === 'chat.permit' && c.params.chatId === 'claude:fam-claude')).toEqual([]);

  // a chat that is running on the machine opens live; a message sent in it goes to that chat on the machine (a real Host queues it behind the turn; the fake one starts it at once)
  await seed('acp:kimi:busy-1', 'Busy on the machine', 'slow work');
  await again
    .locator('.sidebar [data-machine-group="ssh:me@box"]')
    .locator('.machine-chat-row', { hasText: 'Busy on the machine' })
    .click({ timeout: 60_000 });
  await expect(again.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 45_000 });
  await composer(again).fill('after the slow work');
  await again.keyboard.press('Enter');
  await expect
    .poll(
      () =>
        calls()
          .filter((c) => c.method === 'chat.send' && JSON.stringify(c.params).includes('after the slow work'))
          .map((c) => c.params.chatId),
      { timeout: 60_000 },
    )
    .toEqual(['acp:kimi:busy-1']);
  await asAnotherClient('chat.stop', { chatId: 'acp:kimi:busy-1' });
});

test('a chat taken in from the machine and left alone is still there after the app starts again, bound to its machine', async ({
  harness,
}) => {
  const page = harness.page;
  const group = page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  await expect(group.locator('.by-machine-dot.on')).toBeVisible({ timeout: 45_000 });
  await seed('acp:kimi:alone-1', 'Taken in and left alone', 'alone');
  await group.locator('.machine-chat-row', { hasText: 'Taken in and left alone' }).click({ timeout: 60_000 });
  await expect(group.locator('[data-sidebar-chat="acp:kimi:alone-1"]')).toBeVisible({ timeout: 45_000 });
  // no message was sent: the app starts again
  await harness.relaunch();
  const again = harness.page.locator('.sidebar [data-machine-group="ssh:me@box"]');
  await expect(again.locator('.by-machine-dot.on')).toBeVisible({ timeout: 90_000 });
  // it is a chat of this Mac or a row of the machine, never lost; and either opens in the chat view
  const here = again.locator('[data-sidebar-chat="acp:kimi:alone-1"]');
  const there = again.locator('.machine-chat-row', { hasText: 'Taken in and left alone' });
  await expect(here.or(there)).toBeVisible({ timeout: 60_000 });
  await here.or(there).click();
  await expect(harness.page.getByText('fake-host: alone')).toBeVisible({ timeout: 60_000 });
});
