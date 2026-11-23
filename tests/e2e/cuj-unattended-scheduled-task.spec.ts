// CUJ unattended-scheduled-task on both harnesses: a scheduled task with computer control allowed and "Wait and
// notify" runs when it is due with nobody there (the scheduler's tick, with the renderer's clock moved on instead
// of waiting). It wants to control a Mac app nobody authorized: the call is refused with the reason, one
// notification goes out. Its ordinary command approval waits (an hour later the Scheduled page marks the run Needs
// attention) and the notification takes the user to the card; allowing it finishes the run, and Run now runs the task once more.
// The journey runs twice per harness: with the legacy computer_* tools (the desktop tools switched off), and with the
// default desktop tools, where the run asks for Notes through desktop_request_access (Claude Code: request_access on
// mopilot_computer) and the access card it was refused for comes up in the run once the user is there.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { latestChatNotification } from './fixtures/notificationTarget';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.approval-card');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

const task = (harness: 'codex' | 'claude', prompt: string) =>
  [
    'version = 1',
    'id = "nightly-check"',
    'kind = "cron"',
    'name = "Nightly check"',
    `prompt = '${prompt}'`,
    'status = "ACTIVE"',
    // due once a minute: the test moves the scheduler's clock a minute on, and its next tick finds it due
    'rrule = "FREQ=MINUTELY;INTERVAL=1"',
    `harness = "${harness}"`,
    'computer_control = true',
    'on_approval = "wait"',
    `updated_at = ${Date.now()}`,
    '',
  ].join('\n');

/**
 * The default flags, except Codex's own computer use (native.codex.enabled), which a Codex Computer Use install on this
 * Mac could otherwise hand the desktop to instead of MoPilot's desktop_* tools.
 */
const DEFAULT_DESKTOP_TOOLS = { 'native.codex.enabled': false } as const;

const seedTask = (h: 'codex' | 'claude', prompt: string, flags: Record<string, boolean> = COMPUTER_TOOLS) => ({
  uiState: { prefs: { notifyOnComplete: 'always', runSchedules: true } },
  files: (d: Dirs) => {
    const dir = path.join(d.codexHome, 'automations', 'nightly-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'automation.toml'), task(h, prompt));
    // The refused-grant card on opening the run (#277) belongs to the per-app computer_* tools. Since #351 those
    // are hidden while the desktop_* tools are on, so this journey runs with the desktop tools switched off
    // remotely, the configuration where computer_* still serve.
    remoteFlags(flags)(d);
  },
});

async function captureNotifications(h: Harness) {
  await h.app.evaluate(({ Notification }) => {
    (globalThis as any).__shown = [];
    Notification.prototype.show = function (this: any) {
      (globalThis as any).__shown.push(this);
    };
  });
  // This Mac Notes journey runs on macOS; Electron exposes groupId on macOS/Windows.
  const list = () =>
    h.app.evaluate(() =>
      ((globalThis as any).__shown as any[]).map((n) => ({
        title: n.title as string,
        body: n.body as string,
        groupId: n.groupId as string,
      })),
    );
  const click = (i: number) => h.app.evaluate((_, i) => (globalThis as any).__shown[i].emit('click'), i);
  return { list, click };
}

async function journey(page: Page, harness: Harness, who: string, fake: string, cmd: 'APPROVECMD' | 'RUNCMD') {
  // the scheduler starts a moment after boot and the poll below waits for its tick: allow for a loaded machine
  test.setTimeout(100_000);
  const notes = await captureNotifications(harness);
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // the scheduler lives in main and ticks every 30 s; move its clock a minute on instead of waiting for it
  const advance = (ms: number, markOnly = false) =>
    harness.app.evaluate((_, [ms, markOnly]) => (globalThis as any).__schedulerAdvance(ms, markOnly), [ms, markOnly] as const);
  // the run starts by itself: a chat marked as a scheduled run that nobody is attending
  // (the window registers a moment after boot: move the clock on until a tick has found the task due and started the run)
  const runs = () => page.evaluate(async () => Object.keys((await (window as any).native.chats.snapshot()).chats).length);
  await expect
    .poll(
      async () => {
        if ((await runs()) > 0) return true;
        await advance(61_000);
        return false;
      },
      { intervals: [4000], timeout: 40_000 },
    )
    .toBe(true);
  // the refused grant comes first; its reason is what the model reads, and shows in the reply once the approval is answered
  const scheduledSnapshot = () =>
    page.evaluate(async () => {
      const chats = Object.keys((await (window as any).native.chats.snapshot()).chats);
      const all = await Promise.all(chats.map((c) => (window as any).native.session.snapshot(c)));
      return all.flatMap((snapshot, index) => (snapshot?.scheduled ? [{ ...snapshot, chatId: chats[index] }] : []));
    });
  // Chat creation is visible before its scheduled mark; wait for the owner to finish publishing it.
  let snapshots: Awaited<ReturnType<typeof scheduledSnapshot>> = [];
  await expect
    .poll(async () => {
      snapshots = await scheduledSnapshot();
      return snapshots.map((snapshot) => snapshot.scheduled);
    })
    .toEqual([{ unattended: true, computer: true, onApproval: 'wait' }]);
  const snap = snapshots[0];
  // A fast approval/refusal can outrank the start notice. Open this run's latest notification,
  // whichever arrived first; another chat's notification must never satisfy the journey.
  const runNote = async () => latestChatNotification(await notes.list(), snap.chatId);
  // Failure output includes captured owner IDs, without exposing notification bodies/task prompts.
  await expect.poll(async () => (await notes.list()).map((note) => note.groupId)).toContain(snap.chatId);
  await notes.click(await runNote());
  // no card was put up for a grant while nobody was there, and the helper never acted. Opening the run shows the
  // command approval; the card for the refused grant waits until that turn is over (#277: a deferred card is raised
  // only after the turn has ended, so the turn's cleanup cannot erase it)
  await expect(page.locator('.sage-approval')).toHaveCount(0);
  const kinds = () =>
    page.evaluate(async (id) => ((await (window as any).native.session.snapshot(id)).approvals as any[]).map((a) => a.method), snap.chatId);
  await expect.poll(kinds).toEqual([expect.stringMatching(/requestApproval$|^claude\/permission$/)]);
  expect(harness.helper!.log.filter((m) => m.method.startsWith('input.') && m.method !== 'input.idle')).toEqual([]);

  // the command approval waits for the user: one notification, and the Scheduled page marks the run
  await expect(card(page)).toContainText(`Allow ${who} to run this command?`);
  await expect
    .poll(async () => (await notes.list()).filter((n) => /needs your approval|needs your OK/.test(n.title + n.body)).length)
    .toBeGreaterThanOrEqual(1);
  const refusals = (await notes.list()).filter((n) => /needs your OK to control Notes/.test(n.title + n.body));
  expect(refusals.length).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.locator('.sched-row', { hasText: 'Nightly check' }).click();
  // not marked while it has waited a short while; an hour without an answer marks it
  await expect(page.locator('.task-detail').getByText('Recent runs')).toBeVisible();
  await expect(page.locator('.task-detail').getByText('Needs attention')).toHaveCount(0);
  await advance(0, true); // the scheduler sees the approval waiting
  await advance(59 * 60_000, true);
  await expect(page.locator('.task-detail').getByText('Needs attention')).toHaveCount(0);
  await advance(2 * 60_000, true);
  await expect(page.locator('.task-detail').getByText('Needs attention')).toBeVisible();

  // back through the notification: the card is there, allow it, the run finishes
  await expect.poll(async () => (await notes.list()).map((note) => note.groupId)).toContain(snap.chatId);
  await notes.click(await runNote());
  await expect(card(page)).toBeVisible();
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(
    transcript(page).getByText(
      new RegExp(
        `${fake}: CUCALL .*\\[cu: error: Controlling Notes needs the user's OK, and nobody is here to give it.*\\[command: ran\\]`,
      ),
    ),
  ).toBeVisible();
  // the turn is over: the card for the refused grant comes up once someone looks at the chat. The run may have been
  // opened (from its start notification) before the refusal was recorded, so leave it and come back as the user
  // would (the desktop-tools journey below covers the card at the turn's end without leaving the chat); Deny keeps nothing
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(kinds).toEqual(['sage/computerAccess']);
  await expect(page.locator('.sage-approval')).toContainText(`Allow ${who} to control Notes`);
  await page.locator('.sage-approval').getByRole('button', { name: /Deny/ }).click();
  await expect(card(page)).toHaveCount(0);

  // Run now runs the task once more, as a chat of its own
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.locator('.sched-row', { hasText: 'Nightly check' }).click();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.locator('.task-detail')).toHaveCount(0);
  await expect(card(page)).toContainText(new RegExp(`Allow ${who} to control Notes|Allow ${who} to run this command\\?`));
}

/**
 * The same run with the default desktop tools: the scheduled run's desktop_request_access is refused (nobody there)
 * and the run paused; the user opens it from the refusal's notification, answers the command approval, and once the
 * turn is over the deferred access card comes up in the chat without leaving it, whether or not the window has the
 * focus. Allow grants Notes, and the chat's next call into Notes runs without another card.
 */
async function desktopJourney(page: Page, harness: Harness, who: string, fake: string, shot: string) {
  test.setTimeout(100_000);
  const notes = await captureNotifications(harness);
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const advance = (ms: number) => harness.app.evaluate((_, ms) => (globalThis as any).__schedulerAdvance(ms, false), ms);
  const runs = () => page.evaluate(async () => Object.keys((await (window as any).native.chats.snapshot()).chats).length);
  await expect
    .poll(
      async () => {
        if ((await runs()) > 0) return true;
        await advance(61_000);
        return false;
      },
      { intervals: [4000], timeout: 40_000 },
    )
    .toBe(true);
  // the access request was refused with nobody there: one notification, no card, the helper never acted
  const refusal = async () => (await notes.list()).findIndex((n) => /needs your OK to control Notes/.test(n.title + n.body));
  await expect.poll(refusal).toBeGreaterThanOrEqual(0);
  const chatId = await page.evaluate(async () => {
    const chats = Object.keys((await (window as any).native.chats.snapshot()).chats);
    const all = await Promise.all(chats.map((c) => (window as any).native.session.snapshot(c)));
    return chats[all.findIndex((x) => x?.scheduled)];
  });
  const kinds = () =>
    page.evaluate(async (id) => ((await (window as any).native.session.snapshot(id)).approvals as any[]).map((a) => a.method), chatId);
  await expect(page.locator('.sage-approval')).toHaveCount(0);
  expect(harness.helper!.log.filter((m) => m.method.startsWith('input.') && m.method !== 'input.idle')).toEqual([]);

  // the user opens the run from the refusal's notification: the command approval is up; the access card waits for the turn's end
  await notes.click(await refusal());
  await expect.poll(kinds).toEqual([expect.stringMatching(/requestApproval$|^claude\/permission$/)]);
  await expect(card(page)).toContainText(`Allow ${who} to run this command?`);
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(
    transcript(page).getByText(
      new RegExp(
        `${fake}: CUCALL .*\\[cu: error: Access to Notes needs the user's OK, and nobody is here to give it \\(a scheduled task\\).*\\[command: ran\\]`,
      ),
    ),
  ).toBeVisible();

  // the turn is over and the run is still on screen: the access card the call was refused for comes up, with no
  // navigation away and back, focused window or not
  await expect.poll(kinds).toEqual(['sage/computerAccessSet']);
  await expect(page.locator('.sage-approval')).toContainText(`Allow ${who} to use Notes?`);
  await expect(page.locator('.sage-approval .desktop-access-name')).toHaveText(['Notes']);
  await page
    .locator('.sage-approval')
    .getByRole('button', { name: /^Allow/ })
    .click();
  await expect(page.locator('.sage-approval')).toHaveCount(0);
  expect(await page.evaluate(async () => (window as any).native.computer.status().then((s: any) => s.grants.global.length))).toBe(0);

  // the run's next call into Notes goes through on the grant, without another card
  await composer(page).fill(shot);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // fake-codex's model takes text only, so its screenshot comes back as text with no image; fake-claude's gets the image
  const textOnly = fake === 'fake-codex';
  const answer = textOnly ? '(?!<image>)' : '<image> ';
  await expect(transcript(page).getByText(new RegExp(`${fake}: CUCALL .*app_screenshot.*\\[cu: ${answer}.*Notes`))).toBeVisible();
  const noImage = transcript(page).getByText(/No image: this chat's model takes text only/);
  if (textOnly) await expect(noImage.first()).toBeVisible();
  else await expect(noImage).toHaveCount(0);
  await expect(page.locator('.sage-approval')).toHaveCount(0);
  await expect.poll(kinds).toEqual([]);
}

test.describe('Codex', () => {
  test.use({ harnesses: 'both', computerHelper: true, seed: seedTask('codex', 'CUCALL computer_click {"x":1,"y":2} APPROVECMD') });
  test('unattended-scheduled-task on Codex: due with nobody there, the new grant is refused, the command approval waits and is answered from the notification', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Codex', 'fake-codex', 'APPROVECMD');
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'both', computerHelper: true, seed: seedTask('claude', 'CUCALL computer_click {"x":1,"y":2} RUNCMD') });
  test('unattended-scheduled-task on Claude Code: due with nobody there, the new grant is refused, the command approval waits and is answered from the notification', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Claude Code', 'fake-claude', 'RUNCMD');
  });
});

test.describe('Codex, default desktop tools', () => {
  test.use({
    harnesses: 'both',
    computerHelper: true,
    seed: seedTask(
      'codex',
      'CUCALL desktop_request_access {"apps":["Notes"],"reason":"Check the nightly note"} APPROVECMD',
      DEFAULT_DESKTOP_TOOLS,
    ),
  });
  test('unattended-scheduled-task on Codex with the desktop tools: the refused access request comes back as the access card once the run is open, and Allow lets the next call run', async ({
    page,
    harness,
  }) => {
    await desktopJourney(page, harness, 'Codex', 'fake-codex', 'CUCALL desktop_app_screenshot {"app":"Notes"}');
  });
});

test.describe('Claude Code, default desktop tools', () => {
  test.use({
    harnesses: 'both',
    computerHelper: true,
    seed: seedTask(
      'claude',
      'CUCALL mcp__mopilot_computer__request_access {"apps":["Notes"],"reason":"Check the nightly note"} RUNCMD',
      DEFAULT_DESKTOP_TOOLS,
    ),
  });
  test('unattended-scheduled-task on Claude Code with the desktop tools: the refused access request comes back as the access card once the run is open, and Allow lets the next call run', async ({
    page,
    harness,
  }) => {
    await desktopJourney(page, harness, 'Claude Code', 'fake-claude', 'CUCALL mcp__mopilot_computer__app_screenshot {"app":"Notes"}');
  });
});
