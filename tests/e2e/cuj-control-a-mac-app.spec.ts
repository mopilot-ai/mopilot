// CUJ control-a-mac-app on both harnesses, against a fake computer-use helper: Settings → Computer use guides the
// first grant (Accessibility and Screen Recording), the agent asks to control Notes on the authorization card, the
// activity bar shows who controls what, a take-over pauses it (Resume goes on), another chat asking meanwhile waits
// (with a way to view the holder), and a physical Esc stops the turn, lets go of the desktop and lets the waiting
// chat through. (The card's levels, scopes and confirmations are in computer-use.spec.)
// The same journey on the default desktop_* / desktop_app_* tools (takeOverJourney): one card for the whole task
// (#1993) saved with the chat and listed in Settings (#1971); a background batch in TextEdit shows its working-in card,
// whose click opens a live view (#2057) and whose finished steps grow live in the running turn (#2008); Take over makes
// the batch wait, and Done, continue goes on in the same turn (#2016); on the screen, a take-over makes the next click
// wait for Done, continue, and a confirm card raised while taken over shows in the docked panel (#1997) and its Allow
// hands the desktop back (#1902).
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { openedExternal } from './fixtures/externalUrls';
import { PRIVACY_PANES } from '../../shared/skyComputerUse.mjs';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const bar = (page: Page) => page.locator('.cu-activity');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const clicks = (h: Harness) => h.helper!.log.filter((m) => m.method === 'input.click');

async function journey(page: Page, harness: Harness, who: 'Codex' | 'Claude Code', fake: 'fake-codex' | 'fake-claude') {
  const helper = harness.helper!;
  await expect(home(page)).toBeVisible();

  // 1. nothing is granted on this Mac yet: Settings → Computer use explains it and opens the right pane
  helper.permissions.screenRecording = false;
  helper.permissions.accessibility = false;
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Computer use' }).click();
  const guide = page.locator('.cu-guide');
  await expect(guide.locator('.cu-guide-text')).toHaveText(
    'Allow Accessibility for MoPilot in System Settings. Agents can only control apps you approve.',
  );
  // the idle helper quits first (System Settings has no running app to ask to Quit & Reopen) and main opens the pane
  await guide.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(() => openedExternal(harness)).toEqual([PRIVACY_PANES.accessibility]);
  expect(helper.log.filter((m) => m.method === 'permissions.openSettings')).toEqual([]);
  // the user grants both in System Settings
  helper.permissions.screenRecording = true;
  helper.permissions.accessibility = true;
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // 2. the first ask: the card names the agent and the app; Allow in this chat
  await send(page, 'CUCALL computer_click {"x":10,"y":20} SLOW');
  await expect(card(page)).toContainText(`Allow ${who} to control Notes`);
  await pickScope(card(page), /Allow in this chat/);
  await expect(transcript(page).getByText(/\[cu: Done: click in Notes\./)).toBeVisible();
  expect(clicks(harness)).toHaveLength(1);

  // 3. while the turn runs: who controls what, and how to take over or stop
  await expect(bar(page).locator('.elsewhere-title')).toHaveText('Using Notes · Esc to stop');
  const firstChat = await page.evaluate(() => location.hash || location.href);

  // 4. the user moves the mouse: the agent is paused until Done, continue
  helper.pause('takeover');
  await expect(bar(page)).toContainText('You took over Notes');
  await bar(page).getByRole('button', { name: 'Done, continue' }).click();
  await expect(bar(page)).toContainText('Using Notes');
  expect(helper.log.filter((m) => m.method === 'control.resume')).toHaveLength(1);

  // 5. another chat asks for Notes meanwhile: it is granted, then waits for the desktop and can jump to the holder
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await send(page, 'CUCALL computer_click {"x":30,"y":40}');
  await expect(card(page)).toContainText(`Allow ${who} to control Notes`);
  await pickScope(card(page), /Allow once/);
  await expect(bar(page)).toContainText('in use by');
  expect(clicks(harness)).toHaveLength(1);
  await bar(page).getByRole('button', { name: 'View' }).click();
  await expect(transcript(page).getByText(`${fake}: CUCALL computer_click {"x":10,"y":20} SLOW`, { exact: false })).toBeVisible();
  expect(await page.evaluate(() => location.hash || location.href)).toBe(firstChat);

  // 6. a physical Esc: the first turn stops, the desktop is let go, and the waiting chat goes ahead
  helper.pause('escape');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect.poll(() => clicks(harness).length).toBe(2);
  expect(clicks(harness)[1].params).toMatchObject({ x: 30, y: 40, bundleIds: ['com.apple.Notes'] });
  await expect.poll(() => helper.log.filter((m) => m.method === 'control.release').length).toBeGreaterThanOrEqual(1);
  await expect(bar(page)).toHaveCount(0);
}

test.describe('Codex', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });
  test('control-a-mac-app on Codex: first-grant guide, authorization card, activity bar, take-over and Resume, a waiting chat, Esc', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Codex', 'fake-codex');
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });
  test('control-a-mac-app on Claude Code: first-grant guide, authorization card, activity bar, take-over and Resume, a waiting chat, Esc', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Claude Code', 'fake-claude');
  });
});

/** How a harness calls MoPilot's desktop tools (as in cuj-background-app-control): one line of the message per call. */
interface Way {
  who: 'Codex' | 'Claude Code';
  call(name: string, args: object): string;
  /** the last line: the calls show as tool steps */
  steps: string;
}
const CLAUDE: Way = {
  who: 'Claude Code',
  call: (name, args) => `CUCALL mcp__mopilot_computer__${name.replace(/^desktop_/, '')} ${JSON.stringify(args)}`,
  steps: 'CUSTEPS',
};
const CODEX: Way = { who: 'Codex', call: (name, args) => `MCPCU ${name} ${JSON.stringify(args)}`, steps: 'go' };

async function sendLines(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const composerStop = (page: Page) => page.locator('button.send-btn.stop');
const appStrip = (page: Page) => page.locator('.cu-activity.cu-app');
const workingCard = (page: Page, app: string) => page.locator('.working-in-card', { hasText: app });
/** The running group's run of finished control steps: "Captured screen, clicked, typed, clicked in TextEdit". */
const run = (page: Page) => transcript(page).locator('.control-run > .step-row.summary .step-text');
/** The helper requests of `method` since the log had `from` entries. */
const since = (h: Harness, from: number, method: string) => h.helper!.log.slice(from).filter((m) => m.method === method);

async function takeOverJourney(page: Page, harness: Harness, w: Way) {
  const helper = harness.helper!;
  const log = (method: string) => helper.log.filter((m) => m.method === method);
  await expect(home(page)).toBeVisible();

  // 1. one card for the whole task: the apps and the mouse and keyboard together (#1993); Allow in this chat
  await sendLines(page, [
    w.call('desktop_request_access', { apps: ['Notes', 'TextEdit'], reason: 'Tidy the notes', screenControl: true }),
    w.steps,
  ]);
  await expect(card(page)).toHaveAttribute('data-kind', 'computerAccessSet');
  await expect(card(page)).toContainText(`Allow ${w.who} to use your mouse and keyboard in Notes and TextEdit?`);
  await pickScope(card(page), /^Allow in this chat/);
  await expect(transcript(page).getByText(/"granted": \[/)).toBeVisible();
  await expect(composerStop(page)).toHaveCount(0);

  // 2. a batch in TextEdit, in the background: its working-in card opens a live view in place (#2057)
  helper.holdBatches = true;
  await sendLines(page, [
    w.call('desktop_app_screenshot', { app: 'TextEdit' }),
    w.call('desktop_app_batch', {
      app: 'TextEdit',
      actions: [
        { action: 'click', element_index: 1 },
        { action: 'type', element_index: 2, text: 'more' },
      ],
    }),
    w.call('desktop_app_click', { app: 'TextEdit', element_index: 1 }),
    `${w.steps} SLOW`,
  ]);
  await expect.poll(() => log('app.batch').length).toBe(1);
  const textEdit = workingCard(page, 'TextEdit');
  await expect(textEdit).toHaveAttribute('data-status', 'working');
  const view = textEdit.locator('.working-in-main');
  await expect(view).toHaveAttribute('aria-expanded', 'false');
  await view.click();
  await expect(view).toHaveAttribute('aria-expanded', 'true');
  await expect(textEdit.locator('.working-in-live')).toBeVisible();
  await expect(textEdit.locator('.working-in-live-badge')).toHaveText('Live');
  // bringing the app forward is the secondary button now
  await expect(textEdit.getByRole('button', { name: 'Bring TextEdit to the front' })).toBeVisible();

  // 3. Take over mid-batch: the batch is cancelled in the helper and waits; the turn keeps running (#1906)
  await expect(appStrip(page).locator('.elsewhere-title')).toHaveText('Using TextEdit · Untitled');
  await appStrip(page).getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => log('app.cancel').length).toBe(1);
  await expect(appStrip(page)).toContainText('You took over TextEdit');
  await expect(composerStop(page)).toBeVisible();
  expect(log('app.press').filter((m) => !m.batch)).toEqual([]);
  // Done, continue: the same turn goes on; the batch says it was handed back, and the next click runs
  helper.holdBatches = false;
  await appStrip(page).getByRole('button', { name: 'Done, continue' }).click();
  await expect(
    transcript(page)
      .getByText(/The user took over TextEdit and handed it back\. Nothing more was done/)
      .first(),
  ).toBeVisible();
  await expect.poll(() => log('app.press').filter((m) => !m.batch).length).toBe(1);
  await expect(transcript(page).getByText(/stopped by the user/)).toHaveCount(0);
  // the finished steps show live while the turn still runs (#2008)
  // the screenshot, the batch's own words, then the click, in the one app the run names once
  await expect(run(page)).toHaveText('Captured screen, clicked, typed, clicked in TextEdit');
  await expect(composerStop(page)).toBeVisible();
  await expect(appStrip(page).locator('.elsewhere-title')).toHaveText('Using TextEdit · Untitled');
  await composerStop(page).click();
  await expect(composerStop(page)).toHaveCount(0);
  // the card keeps the window as the turn left it: no longer live
  await expect(textEdit).toHaveAttribute('data-status', 'stopped');
  await expect(textEdit.locator('.working-in-live-badge')).toHaveCount(0);
  await view.click();
  await expect(view).toHaveAttribute('aria-expanded', 'false');

  // 4. on the screen: no second card for the mouse and keyboard; the user takes over between two clicks
  const point = { coordinate: [0, 0] };
  await sendLines(page, [
    w.call('desktop_screenshot', {}),
    w.call('desktop_left_click', point),
    w.call('desktop_wait', { duration: 4 }),
    w.call('desktop_left_click', point),
    w.call('desktop_wait', { duration: 4 }),
    w.call('desktop_left_click', { ...point, irreversible: true }),
    w.steps,
  ]);
  await expect.poll(() => log('input.click').length).toBe(1);
  helper.pause('takeover');
  const bar = page.locator('.cu-activity');
  await expect(bar).toContainText('You took over');
  // the chat holds the screen: MoPilot is the docked panel, with no working-in stack over the chat (#1997, #2057)
  await expect(page.locator('html')).toHaveClass(/\bdocked\b/);
  await expect(page.locator('.working-in-stack')).toHaveCount(0);
  // past the wait the second click is due, but it waits for the hand back (#1905); no takeover card either (#1993)
  await page.waitForTimeout(5_000);
  await expect(composerStop(page)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  const resumed = helper.log.length;
  await bar.getByRole('button', { name: 'Done, continue' }).click();
  await expect.poll(() => since(harness, resumed, 'control.resume').length).toBe(1);
  await expect.poll(() => since(harness, resumed, 'input.click').length).toBe(1);

  // 5. taken over again; the click that can't be undone asks first, in the docked panel; its Allow hands back (#1902)
  helper.pause('takeover');
  await expect(bar).toContainText('You took over');
  const confirm = card(page);
  await expect(confirm).toHaveAttribute('data-kind', 'computerConfirm', { timeout: 15_000 });
  await expect(confirm).toContainText(`Allow ${w.who} to`);
  await expect(confirm).toContainText('in Notes');
  await expect(page.locator('html')).toHaveClass(/\bdocked\b/);
  const allowed = helper.log.length;
  await pickScope(confirm, /Allow once/);
  await expect.poll(() => since(harness, allowed, 'control.resume').length).toBe(1);
  await expect.poll(() => since(harness, allowed, 'input.click').length).toBe(1);
  // the turn ends: the desktop is let go and the window is back in its place
  await expect(composerStop(page)).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => log('control.release').length).toBeGreaterThanOrEqual(1);
  await expect(page.locator('html')).not.toHaveClass(/\bdocked\b/);
  await expect(bar).toHaveCount(0);
  await expect(transcript(page).getByText(/didn't allow MoPilot to control the screen/)).toHaveCount(0);

  // 6. afterwards the chat's grant is saved with it: Settings → Computer use lists both apps under "Allowed in a
  // chat" (#1971), and Remove takes one off
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Computer use' }).click();
  const inChat = page.locator('.settings-group', { hasText: 'Allowed in a chat' });
  for (const app of ['Notes', 'TextEdit']) await expect(inChat.getByRole('button', { name: `Remove ${app}` })).toBeVisible();
  await inChat.getByRole('button', { name: 'Remove Notes' }).click();
  await expect(inChat.getByRole('button', { name: 'Remove Notes' })).toHaveCount(0);
  await expect(inChat.getByRole('button', { name: 'Remove TextEdit' })).toBeVisible();
}

// the default switches, but not Codex's own computer use (native.codex.enabled), as in cuj-background-app-control
test.describe('Codex, desktop tools', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });
  test('take over and continue on Codex: one card, Settings, live view, Take over mid-batch and Done, a screen take-over, a confirm while taken over', async ({
    page,
    harness,
  }) => {
    await takeOverJourney(page, harness, CODEX);
  });
});

test.describe('Claude Code, desktop tools', () => {
  test.use({ harnesses: 'claude', computerHelper: true });
  test('take over and continue on Claude Code: one card, Settings, live view, Take over mid-batch and Done, a screen take-over, a confirm while taken over', async ({
    page,
    harness,
  }) => {
    await takeOverJourney(page, harness, CLAUDE);
  });
});
