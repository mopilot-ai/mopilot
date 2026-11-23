// CUJ background-app-control on both harnesses, under the default switches, against a fake computer-use helper
// (TextEdit runs behind Notes; nothing touches the real screen). Since #348/#351 the default computer-use path is
// the desktop_* (display scope) and desktop_app_* (background, one app) tools on the shared host: Claude Code calls
// them on the mopilot_computer SDK MCP server under short names (request_access, app_screenshot, ...), Codex through
// the thread's sage-mcp server under their registry names. The journey:
// 1. the agent asks for TextEdit: the app-access card (Deny / Allow in this chat, Always allow in its menu); Allow grants it for the chat;
// 2. it works there in the background (a screenshot, a click by element index, typing, a menu path): the helper gets
//    app.* requests only (MoPilot stays in front: nothing is opened, activated or taken over), and the chat's
//    control strip says "Using TextEdit · Untitled" with Take over and Stop;
// 3. Always allow in one chat: a new chat's request is granted with no card ("(always allowed)"); once it is
//    removed in Settings → Computer use, the next new chat gets the card again;
// 4. a click on a Delete button needs its own hold-to-confirm card; Deny refuses it;
// 5. Stop while a batch runs: the batch is cancelled in the helper, the turn ends and the app lock goes, so another
//    chat can work in TextEdit straight away.
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { remoteFlags } from './fixtures/flags';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const strip = (page: Page) => page.locator('.cu-activity.cu-app');

/** How each harness calls MoPilot's desktop tools: `call(name, args)` is one line of the message. */
interface Way {
  who: 'Claude Code' | 'Codex';
  call(name: string, args: object): string;
  /** the last line: the calls show as tool steps, and an interrupt ends the turn at once */
  steps: string;
  /** the fake model takes text only (fake-codex's inputModalities), so a screenshot comes back as text with no image */
  textOnly: boolean;
}
const CLAUDE: Way = {
  who: 'Claude Code',
  // desktop_request_access is request_access, desktop_app_click is app_click (hostServers.cjs)
  call: (name, args) => `CUCALL mcp__mopilot_computer__${name.replace(/^desktop_/, '')} ${JSON.stringify(args)}`,
  steps: 'CUSTEPS',
  textOnly: false,
};
const CODEX: Way = { who: 'Codex', call: (name, args) => `MCPCU ${name} ${JSON.stringify(args)}`, steps: 'go', textOnly: true };

async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  // each line is a block of its own in the editor
  await expect(composer(page)).toHaveText(lines.join(''));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Opens the steps of the chat's latest turn, which sit under "Worked for" (or "Stopped after") once it ends. */
async function openSteps(page: Page) {
  await transcript(page)
    .getByRole('button', { name: /^(Worked for|Stopped after)/ })
    .last()
    .click();
}

async function newChat(page: Page) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
}

const ACCESS = { apps: ['TextEdit'], reason: 'Edit the draft' };
const TEXTEDIT = ['com.apple.TextEdit'];

/** Requests that would bring an app forward, take over the screen or move the user's pointer. */
const FOREGROUND = (m: string) =>
  ['apps.open', 'apps.hideOthers', 'control.acquire', 'glow.start'].includes(m) ||
  (m.startsWith('input.') && !['input.idle', 'input.cursor'].includes(m));

async function journey(page: Page, harness: Harness, w: Way) {
  const helper = harness.helper!;
  const log = (method: string) => helper.log.filter((m) => m.method === method);
  await expect(home(page)).toBeVisible();

  // 1. access to TextEdit: one card for the set of apps; Allow grants it for this chat
  await send(page, [w.call('desktop_request_access', ACCESS), w.steps]);
  const access = card(page);
  await expect(access).toHaveAttribute('data-kind', 'computerAccessSet');
  await expect(access).toContainText(`Allow ${w.who} to use TextEdit?`);
  await expect(access).toContainText('“Edit the draft”');
  for (const name of [/^Deny/, /^Allow in this chat/, /^Always allow/]) await expect(access.getByRole('button', { name })).toBeVisible();
  await access.getByRole('button', { name: /^Allow/ }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(
    transcript(page).getByText(/"granted": \[\s*\{\s*"app": "TextEdit",\s*"bundleId": "com\.apple\.TextEdit",\s*"tier": "full"/),
  ).toBeVisible();
  await openSteps(page);
  await expect(transcript(page).getByText('Asked to use TextEdit', { exact: true })).toBeVisible();

  // 2. background work in TextEdit while the turn goes on: no card, only app.* requests to the helper
  await send(page, [
    w.call('desktop_app_screenshot', { app: 'TextEdit' }),
    w.call('desktop_app_click', { app: 'TextEdit', element_index: 1 }),
    w.call('desktop_app_type', { app: 'TextEdit', element_index: 2, text: 'Hello from the agent' }),
    w.call('desktop_app_menu', { app: 'TextEdit', path: ['Format', 'Font', 'Show Fonts'] }),
    `${w.steps} SLOW`,
  ]);
  // a model that takes images gets the screenshot; a text-only one gets the window as text, and is told why
  const shot = w.textOnly ? '\\[cu: Window 88' : '\\[cu: <image> Window 88';
  await expect(transcript(page).getByText(new RegExp(`${shot} "Untitled" of TextEdit: coordinate frame 800x600 pixels`))).toBeVisible();
  const noImage = transcript(page).getByText(/No image: this chat's model takes text only/);
  if (w.textOnly) await expect(noImage.first()).toBeVisible();
  else await expect(noImage).toHaveCount(0);
  await expect(
    transcript(page).getByText(/\[cu: \{"action":"menu","effect":"confirmed","route":"ax"[^\]]*"path":"Format > Font > Show Fonts"/),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  // the agent's own capture; the "working in" card's thumbnails are helper captures with tree: false
  expect(
    log('app.screenshot')
      .filter((m) => m.params.tree !== false)
      .map((m) => m.params),
  ).toEqual([expect.objectContaining({ pid: 4343, bundleIds: TEXTEDIT, tree: true })]);
  // [1] is the Bold button: pressed through accessibility; [2] the document: its text set
  expect(log('app.press').map((m) => m.params)).toEqual([
    expect.objectContaining({ pid: 4343, bundleIds: TEXTEDIT, windowId: 88, id: '0.0', action: 'AXPress', verify: true }),
  ]);
  expect(log('app.setText').map((m) => m.params)).toEqual([
    expect.objectContaining({ pid: 4343, id: '0.1', text: 'Hello from the agent', mode: 'insert', verify: true }),
  ]);
  expect(log('app.menuRefresh').map((m) => m.params.menu)).toEqual(['Format']);
  expect(log('app.menu').map((m) => m.params.path)).toEqual([['Format', 'Font', 'Show Fonts']]);
  // MoPilot stayed in front: nothing was opened or activated, the screen was never taken over
  expect(helper.log.filter((m) => FOREGROUND(m.method)).map((m) => m.method)).toEqual([]);
  // the chat's control strip while the turn holds TextEdit
  await expect(strip(page).locator('.elsewhere-title')).toHaveText('Using TextEdit · Untitled');
  await expect(strip(page).getByRole('button', { name: 'Take over' })).toBeVisible();
  await strip(page).getByRole('button', { name: 'Stop' }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  // each action reads as what it did in the thread
  await openSteps(page);
  await transcript(page).getByRole('button', { name: 'Captured screen, clicked, typed, used a menu in TextEdit' }).click();
  for (const step of ['Captured screen', 'Clicked “Bold”', 'Typed 20 characters', 'Chose Format › Font › Show Fonts']) {
    await expect(transcript(page).getByText(step, { exact: true }).and(page.locator('.step-text'))).toBeVisible();
  }

  // 3. Always allow in a new chat: remembered for every chat
  await newChat(page);
  await send(page, [w.call('desktop_request_access', ACCESS), w.steps]);
  await expect(card(page)).toContainText(`Allow ${w.who} to use TextEdit?`);
  await pickScope(card(page), /^Always allow/);
  await expect(transcript(page).getByText(/"granted": \[\s*\{\s*"app": "TextEdit"/)).toBeVisible();
  // the next new chat: granted with no card, and the step says why
  await newChat(page);
  await send(page, [w.call('desktop_request_access', ACCESS), w.steps]);
  await expect(transcript(page).getByText(/"alwaysAllowed": \[\s*"TextEdit"\s*\]/)).toBeVisible();
  await openSteps(page);
  await expect(transcript(page).getByText('Using TextEdit (always allowed)', { exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  // removed in Settings → Computer use
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Computer use' }).click();
  const always = page.locator('.settings-group', { hasText: 'Always allowed' });
  await expect(always).toContainText('TextEdit');
  await always.getByRole('button', { name: 'Remove TextEdit' }).click();
  await expect(always).toContainText('No apps yet');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  // so the next new chat asks again
  await newChat(page);
  await send(page, [w.call('desktop_request_access', ACCESS), w.steps]);
  await expect(card(page)).toContainText(`Allow ${w.who} to use TextEdit?`);
  await card(page)
    .getByRole('button', { name: /^Allow/ })
    .click();
  await expect(transcript(page).getByText(/"granted": \[\s*\{\s*"app": "TextEdit"/)).toBeVisible();
  await expect(transcript(page).getByText(/alwaysAllowed/)).toHaveCount(0);

  // 4. a click on Delete can't be undone: its own card, hold to confirm; Deny refuses it
  await send(page, [
    w.call('desktop_app_screenshot', { app: 'TextEdit' }),
    w.call('desktop_app_click', { app: 'TextEdit', element_index: 3 }),
    w.steps,
  ]);
  const confirm = card(page);
  await expect(confirm).toHaveAttribute('data-kind', 'computerConfirm');
  await expect(confirm).toContainText(`Allow ${w.who} to delete in TextEdit? This can't be undone.`);
  await expect(confirm.getByRole('button', { name: /Allow once/ })).toContainText('hold ⌘⏎');
  await expect(confirm.getByRole('button', { name: /Always allow/ })).toHaveCount(0);
  await confirm.getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page).getByText(/\[cu: error: The user didn't confirm: delete in TextEdit/)).toBeVisible();
  expect(log('app.press').filter((m) => m.params.id === '0.2')).toEqual([]);
  expect(log('app.click')).toEqual([]);

  // 5. Stop while a batch runs in TextEdit: the helper cancels it, the turn ends and TextEdit is free again
  helper.holdBatches = true;
  await send(page, [
    w.call('desktop_app_batch', {
      app: 'TextEdit',
      actions: [
        { action: 'click', element_index: 1 },
        { action: 'type', element_index: 2, text: 'more' },
      ],
    }),
    w.steps,
  ]);
  await expect.poll(() => log('app.batch').length).toBe(1);
  const batchId = log('app.batch')[0].params.batchId;
  await expect(strip(page).locator('.elsewhere-title')).toHaveText('Using TextEdit · Untitled');
  await strip(page).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => log('app.cancel').map((m) => m.params.batchId)).toEqual([batchId]);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(transcript(page).getByRole('button', { name: /^Stopped after/ })).toHaveCount(1);
  helper.holdBatches = false;
  // another chat gets TextEdit at once (the lock went with the turn)
  await newChat(page);
  await send(page, [
    w.call('desktop_request_access', ACCESS),
    w.call('desktop_app_screenshot', { app: 'TextEdit' }),
    w.call('desktop_app_click', { app: 'TextEdit', element_index: 1 }),
    w.steps,
  ]);
  await card(page)
    .getByRole('button', { name: /^Allow/ })
    .click();
  await expect(transcript(page).getByText(/\[cu: \{"action":"click","effect":"confirmed","route":"ax"[^\]]*"label":"Bold"/)).toBeVisible();
  await expect(transcript(page).getByText(/Another chat is working in TextEdit/)).toHaveCount(0);
  expect(log('app.press').filter((m) => m.params.id === '0.0')).toHaveLength(2);
  expect(helper.log.filter((m) => FOREGROUND(m.method)).map((m) => m.method)).toEqual([]);
}

test.describe('Claude Code', () => {
  // the default switches: the desktop_* and desktop_app_* tools replace computer_*
  test.use({ harnesses: 'claude', computerHelper: true });
  test('background-app-control on Claude Code: access card, background actions with the control strip, Always allow and its removal, a destructive confirm, Stop mid-batch', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, CLAUDE);
  });
});

test.describe('Codex', () => {
  // the default switches, but for Codex's own computer use (native.codex.enabled): on a Mac with Codex Computer Use
  // installed it would take the desktop tools away from a Codex chat, as in computer-use.spec's default switches
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });
  test('background-app-control on Codex: access card, background actions with the control strip, Always allow and its removal, a destructive confirm, Stop mid-batch', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, CODEX);
  });
});
