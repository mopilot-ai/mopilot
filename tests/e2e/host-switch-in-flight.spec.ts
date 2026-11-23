// e2e-runner: bench
// #4951: Switch host from a machine chat back to This Mac around the chat's first message, with the time of every step.
// Two tests, each short enough for one 12-minute lane slot (`-g "cases 1 and 2"`, `-g "case 3"`):
//  - cases 1 and 2: a new chat on the machine; once the chat exists and before its reply, the Switch host row is read at +2 s, +4 s and +6 s after Send and the switch is pressed once; after the reply the switch is pressed again and must go through (the folder is asked once);
//  - case 3: a new chat; 120 s after its reply the Mac's state (Stop button, spinner beside Send, queue row) is recorded and the switch is pressed.
// REAL mode (MINI_ADDRESS=<ssh destination>, MINI_AGENT=<agent label, default Big Pickle>): the machine is added over ssh in the VM; run in the isolated VM only (scripts/vm-exec.sh --vm mopilot-work). Chats are titled "[test]".
// FAKE mode (no MINI_ADDRESS, macOS): the repo's fake ssh and resident fake Host stand in (fixtures/fake-ssh/host-chats.cjs), to prove the steps' selectors; the fake Host does not take a continue, so the switch itself is only pressed and what the dialog says is recorded.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { connectSocket } from '../support/connectSocket';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { FAKE_SSH, FAKE_SSH_BIN } from './fixtures/fakeSsh';
import { withPath } from './fixtures/nodeCommand';
import { shoot, SYSTEM_THEME, themeSeed } from './fixtures/shoot';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const ADDRESS = process.env.MINI_ADDRESS ?? '';
const REAL = !!ADDRESS;
const AGENT = process.env.MINI_AGENT ?? 'Big Pickle';
test.skip(
  process.platform !== 'darwin',
  'the app and its basic harness (the fake machine, a fake opencode) are admitted only on macOS: this spec is routed to a Mac and, with MINI_ADDRESS, runs in the lane VM',
);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switch4951-')));
const FOLDER = path.join(ROOT, 'projects/app');
fs.mkdirSync(path.join(FOLDER, '.git'), { recursive: true });
const RESIDENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')));
const SOCK = path.join(RESIDENT, 'h.sock');
const AGENTS = ['kimi'].map((id) => ({
  id,
  detected: true,
  signedIn: true,
  models: [{ id: `${id}-d`, name: `${id} default`, default: true, efforts: ['low'], defaultEffort: 'low' }],
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
  if (REAL) return;
  resident = spawn(process.execPath, [path.join(FAKE_SSH, 'host-chats.cjs')], {
    env: { ...process.env, FAKE_HOST_CHATS_SOCK: SOCK },
    stdio: 'ignore',
  });
  (await connectSocket(SOCK, 'the resident Host to accept a connection', { timeoutMs: 10_000 })).destroy();
});
test.afterAll(() => {
  resident?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(RESIDENT, { recursive: true, force: true });
});

if (REAL)
  test.use({
    harnesses: 'claude',
    // a This Mac chat on the agent the machine also has (a fake opencode here, the machine's own is real), so it can be switched there
    acp: { opencode: {} },
    env: { MOPILOT_HOST_DEV: '1', MOPILOT_CORE: process.env.MOPILOT_CORE ?? '' },
    seed: { uiState: themeSeed('light') },
  });
else
  test.use({
    harnesses: 'codex',
    acp: { kimi: {} },
    shellPath: [FAKE_SSH_BIN],
    env: {
      MOPILOT_HOST_DEV: '1',
      FAKE_HOST_ROOT: ROOT,
      FAKE_HOST_CHATS_SOCK: SOCK,
      FAKE_HOST_HARNESSES: JSON.stringify(AGENTS),
      PATH: withPath([FAKE_SSH_BIN]),
    },
    seed: { uiState: SYSTEM_THEME, userData: { 'host-registry.json': { version: 1, hosts: [MACHINE] } } },
  });
test.setTimeout(12 * 60_000);

// a started chat's host chip in the composer footer; a new chat picks its machine in the context bar's Run on chip
const chip = (page: Page) => page.locator('button.host-chip');
const runOn = (page: Page) => page.locator('button.host-ctx');
const menu = (page: Page) => page.getByRole('menu', { name: 'My machines' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const stamp = () => new Date().toISOString();

/** The steps of one test, each with its time; written to the run's results as switch4951-<name>.json. */
function recorder(name: string) {
  const log: Record<string, unknown>[] = [];
  return {
    log,
    mark(step: string, data: Record<string, unknown> = {}) {
      const row = { at: stamp(), step, ...data };
      log.push(row);
      console.log(`STEP ${JSON.stringify(row)}`);
    },
    save: () => fs.writeFileSync(test.info().outputPath(`switch4951-${name}.json`), JSON.stringify(log, null, 2)),
  };
}

/** What the Mac shows of the chat now: the Stop button, what sits beside Send, the queue row, whether the turn's "Worked for" line is there. */
const view = (page: Page) =>
  page.evaluate(() => ({
    stop: document.querySelectorAll('button[aria-label="Stop"]').length,
    startingSpinner: document.querySelectorAll('button[aria-label="Starting chat"]').length,
    spinners: [...document.querySelectorAll('.composer-right .spinner, .composer-right [class*="spin"]')].map((e) =>
      e.outerHTML.slice(0, 200),
    ),
    composerRight: document.querySelector('.composer-right')?.innerHTML.replace(/\s+/g, ' ').slice(0, 1800) ?? null,
    queueRows: document.querySelectorAll('.queued-list, .queued-row, [class*="queued"]').length,
    worked: /Worked for/.test(document.body.innerText),
    fakeReply: document.body.innerText.includes('fake-host:'),
  }));

/** The turn's reply is in the thread: its "Worked for" line on a real agent, the fake Host's own text on the fake one. */
const replied = async (page: Page) => {
  const v = await view(page);
  return REAL ? v.worked : v.fakeReply;
};

async function addMachine(page: Page, mark: ReturnType<typeof recorder>['mark']) {
  await expect(runOn(page)).toHaveAttribute('aria-label', 'Run on: This Mac, online', { timeout: 60_000 });
  if (!REAL) return;
  // Add machine… opens the Add a machine sheet in place over the new chat
  await runOn(page).click();
  await menu(page)
    .getByRole('menuitem', { name: /Add machine/ })
    .click();
  const sheet = page.locator('.dialog', { hasText: 'Add a machine' });
  await sheet.getByLabel('Machine', { exact: true }).fill(ADDRESS);
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet).toContainText(/is ready|Start a chat on it/, { timeout: 8 * 60_000 });
  mark('machine added');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
}

/** A new chat targeted at the machine with its folder, then the message sent; resolves with the Send time once the chat exists. */
async function sendNewMachineChat(
  page: Page,
  text: string,
  mark: ReturnType<typeof recorder>['mark'],
  where: 'machine' | 'this-mac' = 'machine',
) {
  await standaloneNewChat(page).click();
  if (REAL && where === 'this-mac') {
    // a chat that runs here first, on the same agent the machine has
    await openHarnessList(page);
    await page
      .locator('.hp-harnesses .hp-row', { hasText: /open ?code/i })
      .first()
      .click({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  } else if (REAL) {
    await runOn(page).click();
    await menu(page)
      .getByRole('menuitemradio')
      .filter({ hasNotText: /This Mac/ })
      .first()
      .click();
    const dialog = page.locator('.dialog');
    await expect(dialog.locator('.host-picker-path')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.locator('.host-picker-path')).not.toHaveText(/Loading/, { timeout: 150_000 });
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
    await expect(page.locator('.ctxbar .ctx-btn').first()).toHaveAttribute('aria-label', /·/, { timeout: 30_000 });
    await page
      .getByRole('button', { name: /Select model|Model/ })
      .first()
      .click();
    await page.getByText(AGENT, { exact: false }).last().click({ timeout: 10_000 });
    await page.keyboard.press('Escape');
  } else {
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
    await page.locator('.ctxbar .ctx-btn').first().click();
    await page.getByText('Folder on box…').click({ timeout: 45_000 });
    const dialog = page.locator('.dialog');
    await expect(dialog.locator('.host-picker-path')).toHaveText(ROOT, { timeout: 45_000 });
    await dialog.locator('.host-picker-open', { hasText: 'projects' }).click();
    await dialog.locator('.host-picker-open', { hasText: 'app' }).click();
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
  }
  await composer(page).fill(text);
  const sentAt = Date.now();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  mark('sent', { text, sentAt: new Date(sentAt).toISOString() });
  // the chat exists once the thread has its own title and the Switch host row stops saying to send a message first
  await expect.poll(async () => (await switchRow(page)).title !== 'Send a message first', { timeout: 60_000, intervals: [200] }).toBe(true);
  mark('chat exists', { afterMs: Date.now() - sentAt });
  return sentAt;
}

/** The Switch host row of the chip menu: whether it is off and why. */
async function switchRow(page: Page) {
  await chip(page).click();
  const row = menu(page).getByRole('menuitem', { name: /Switch host/ });
  const state = { disabled: await row.getAttribute('aria-disabled'), title: await row.getAttribute('title') };
  await page.keyboard.press('Escape');
  return state;
}

/** Presses Switch host to This Mac: the row, the dialog's words, the folder, the chip after. */
async function switchBack(
  page: Page,
  label: string,
  mark: ReturnType<typeof recorder>['mark'],
  target: 'machine' | 'this-mac' = 'this-mac',
) {
  const row = await switchRow(page);
  mark(`${label}: switch pressed`, { row, view: await view(page) });
  if (row.disabled === 'true') return 'row-off';
  await chip(page).click();
  await menu(page)
    .getByRole('menuitem', { name: /Switch host/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Switch host' });
  const pick =
    target === 'this-mac'
      ? dialog.getByRole('radio', { name: /This Mac/ })
      : dialog
          .getByRole('radio')
          .filter({ hasNotText: /This Mac/ })
          .first();
  await pick.click();
  const folder = dialog.getByLabel('Folder on the host');
  const prefilled = await folder.inputValue();
  mark(`${label}: dialog opened`, { folderPrefilled: prefilled, words: await dialog.innerText() });
  if (!prefilled) await folder.fill(target === 'this-mac' ? os.homedir() : (process.env.MINI_FOLDER ?? '/home/hostkey'));
  await dialog.getByRole('button', { name: 'Switch host', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Continue without changes' })
    .click({ timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(6_000);
  const open = await dialog.isVisible().catch(() => false);
  mark(`${label}: result`, {
    dialog: open ? await dialog.innerText() : '(closed)',
    chip: await chip(page).getAttribute('aria-label'),
    view: await view(page),
  });
  if (open) await dialog.getByRole('button', { name: 'Cancel' }).click();
  return open ? 'refused' : 'switched';
}

test('cases 1 and 2: Switch host before the reply, then after it', async ({ page }) => {
  const { mark, save } = recorder('cases-1-2');
  await addMachine(page, mark);
  const sentAt = await sendNewMachineChat(page, '[test] case 1: reply with one short sentence', mark);
  // the row at +2 s, +4 s and +6 s after Send (the agent's session is starting, then the turn runs); the last one presses it
  for (const at of [2_000, 4_000]) {
    await page.waitForTimeout(Math.max(0, sentAt + at - Date.now()));
    mark(`case 1: row at +${at / 1000}s`, { row: await switchRow(page), view: await view(page) });
  }
  await page.waitForTimeout(Math.max(0, sentAt + 6_000 - Date.now()));
  const early = await switchBack(page, 'case 1 (+6s)', mark);
  await shoot(page, 'switch4951-case1');
  mark('case 1 outcome', { outcome: early });
  // case 2: after the reply
  await expect.poll(async () => await replied(page), { timeout: 120_000 }).toBe(true);
  mark('reply seen', { view: await view(page) });
  const late = await switchBack(page, 'case 2', mark);
  await shoot(page, 'switch4951-case2');
  mark('case 2 outcome', { outcome: late });
  save();
  if (REAL) {
    expect(late, 'after the reply the chat goes back to This Mac').toBe('switched');
    expect(early, 'before the reply the switch is off or refused with the busy words').not.toBe('switched');
  }
});

test('case 3: Switch host 120 s after a reply', async ({ page }) => {
  const { mark, save } = recorder('case-3');
  await addMachine(page, mark);
  await sendNewMachineChat(page, '[test] case 3: reply with one short sentence', mark);
  await expect.poll(async () => await replied(page), { timeout: 120_000 }).toBe(true);
  mark('reply seen', { view: await view(page) });
  await page.waitForTimeout(Number(process.env.CASE3_WAIT_MS ?? 120_000));
  mark('case 3: state 120 s after the reply', { view: await view(page), row: await switchRow(page) });
  await shoot(page, 'switch4951-case3-before');
  const outcome = await switchBack(page, 'case 3', mark);
  await shoot(page, 'switch4951-case3');
  mark('case 3 outcome', { outcome });
  save();
  if (REAL) expect(outcome, 'two minutes after a reply the chat goes back to This Mac').toBe('switched');
});

test('case C1: a This Mac chat is switched to the machine, answered there, and switched back', async ({ page }) => {
  test.skip(!REAL, 'needs a real machine');
  const { mark, save } = recorder('case-c1');
  await addMachine(page, mark);
  await sendNewMachineChat(page, '[test] C1 on this mac: reply with one short sentence', mark, 'this-mac');
  // the fake opencode on this Mac answers "fake-acp: <text>"
  await expect(page.getByText(/fake-acp:/).first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await view(page)).stop, { timeout: 60_000 }).toBe(0);
  mark('reply seen (This Mac)', { view: await view(page) });
  const out = await switchBack(page, 'C1 to machine', mark, 'machine');
  mark('C1 to machine outcome', { outcome: out });
  await shoot(page, 'switch4951-c1-machine');
  if (out === 'switched') {
    await composer(page).fill('[test] C1 on the machine: reply with one short sentence');
    const sentAt = Date.now();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    mark('sent (machine)', { sentAt: new Date(sentAt).toISOString() });
    for (const at of [2_000, 4_000, 6_000]) {
      await page.waitForTimeout(Math.max(0, sentAt + at - Date.now()));
      mark(`C1 row at +${at / 1000}s`, { row: await switchRow(page), view: await view(page) });
    }
    await expect.poll(async () => (await view(page)).worked && (await view(page)).stop === 0, { timeout: 120_000 }).toBe(true);
    mark('reply seen (machine)', { view: await view(page) });
    const back = await switchBack(page, 'C1 back', mark, 'this-mac');
    mark('C1 back outcome', { outcome: back });
    expect(back).toBe('switched');
  }
  save();
  expect(out, 'a This Mac chat goes to the machine').toBe('switched');
});

test('case C2: after a cold Host start, Switch host at +1 s to +10 s, after the reply and after 120 s', async ({ page }) => {
  test.skip(!REAL, 'needs a real machine');
  const { mark, save } = recorder('case-c2');
  await addMachine(page, mark);
  const sentAt = await sendNewMachineChat(page, '[test] C2 cold: reply with one short sentence', mark);
  let answered = false;
  for (let at = 1_000; at <= 10_000; at += 1_000) {
    await page.waitForTimeout(Math.max(0, sentAt + at - Date.now()));
    const v = await view(page);
    answered = v.worked;
    mark(`C2 row at +${at / 1000}s`, { row: await switchRow(page), view: v });
  }
  // pressed once before the reply when it is not in yet
  if (!answered) {
    const early = await switchBack(page, 'C2 (+10s)', mark);
    mark('C2 early outcome', { outcome: early });
    expect(early).not.toBe('switched');
  }
  await expect.poll(async () => await replied(page), { timeout: 120_000 }).toBe(true);
  mark('reply seen', { view: await view(page) });
  await page.waitForTimeout(120_000);
  mark('C2: state 120 s after the reply', { view: await view(page), row: await switchRow(page) });
  const late = await switchBack(page, 'C2 (+120s)', mark);
  mark('C2 late outcome', { outcome: late });
  save();
  expect(late).toBe('switched');
});
