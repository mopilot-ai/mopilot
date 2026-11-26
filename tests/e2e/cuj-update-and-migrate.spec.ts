// CUJ update-and-migrate: the app quits and starts again on the same profile with a Codex goal and a Claude Code turn
// running, as Restart to update does (electron/updates/updater.cjs install(): the exit gate, then Squirrel's quitAndInstall,
// which quits through before-quit; Squirrel needs a signed, packaged build, so the quit is app.quit() here). Chats,
// a site grant and a setting are all there afterwards, the goal shows paused, and nothing runs again by itself.
// Composer drafts are kept for the app's run only (docs/composer-goal.md); the 0.2.0 data format is persist-migration.spec.ts.
// Then the restart itself (#1832, #1835), with fixtures/update-hook.cjs standing in for Squirrel: Restart to update and
// the stealth restart (after ten idle, unfocused minutes, on the hook's clock) both reopen the chat the window showed.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';
import { expectGoalRunning, goalCard } from './fixtures/goal';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a minimized window needs a window manager, which the Linux runner’s virtual display has none of');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  // the composer shows a multi-line message without its line breaks
  await expect(composer(page)).toHaveText(text.replace(/\n/g, ''));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
/** Settings → Show reasoning, read or set. */
async function showReasoning(page: Page, set?: boolean): Promise<string | null> {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  const toggle = page.locator('.settings-row', { hasText: 'Show reasoning' }).getByRole('switch');
  await expect(toggle).toBeVisible();
  if (set !== undefined && (await toggle.getAttribute('aria-checked')) !== String(set)) await toggle.click();
  if (set !== undefined) await expect(toggle).toHaveAttribute('aria-checked', String(set));
  const on = await toggle.getAttribute('aria-checked');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  return on;
}
/** Opens the sidebar chat whose transcript shows `text` (both chats are titled by the fakes' title helper). */
async function openChatShowing(page: Page, text: string) {
  const rows = sidebar(page).locator('.thread-row');
  await expect(rows.first()).toBeVisible();
  // the chat on screen may be it already (Back to app returns to the chat Settings was opened from); checked first,
  // so a row's click is never judged by the transcript it is leaving
  if (await transcript(page).getByText(text, { exact: true }).first().isVisible()) return;
  for (let i = 0; i < (await rows.count()); i++) {
    await rows.nth(i).click();
    const hit = await transcript(page)
      .getByText(text, { exact: true })
      .first()
      .waitFor({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (hit) return;
  }
  throw new Error(`no chat shows "${text}"`);
}
const turnStarts = (h: Harness) =>
  h.codexLog().filter((e) => e.method === 'turn/start' && !/as a short chat title/.test(e.params.input?.[0]?.text ?? ''));
const claudeUsers = (h: Harness) =>
  h
    .claudeLog()
    .filter(
      (e) => e.kind === 'in' && e.msg?.type === 'user' && !/as a short chat title|"\/usage"/.test(JSON.stringify(e.msg.message?.content)),
    );

const PAGE = '<!doctype html><title>Fixture page</title><h1>Kept across the update</h1><p>pineapple-42</p>';
let server: http.Server;
let port = 0;
test.beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.use({ harnesses: 'both' });

test('update-and-migrate: quit and relaunch with a Codex goal and a Claude Code turn running; chats, grant and setting kept, goal paused', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  expect(await showReasoning(page, false)).toBe('false');

  // a site allowed for good, on Claude Code
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  const site = `http://127.0.0.1:${port}`;
  await send(page, `CUCALL mcp__mopilot_browser__navigate {"url":"${site}/"}\nCUCALL mcp__mopilot_browser__get_page_text {}`);
  const card = page.locator('.sage-approval');
  await expect(card).toContainText(`Allow Claude Code to use ${site}`);
  await card.getByRole('radio', { name: 'Read only' }).click();
  await pickScope(card, /Always allow/);
  await expect(transcript(page)).toContainText('pineapple-42');
  const sites = () => page.evaluate(() => (window as any).native.browser.sites());
  expect(JSON.stringify(await sites())).toContain(`127.0.0.1:${port}`);
  // then a long turn, still running at the quit
  await send(page, 'long job SLOW');
  await expect(stop(page)).toBeVisible();

  // a Codex goal pursuing
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Codex', 'Fake Model One');
  await send(page, '/goal keep at it SLOW');
  await expectGoalRunning(page);
  const threadId = harness.codexLog().find((e) => e.method === 'thread/goal/set')!.params.threadId as string;

  await harness.quit();
  const codexBefore = turnStarts(harness).length;
  const claudeBefore = claudeUsers(harness).length;
  const logBefore = harness.codexLog().length;
  await harness.relaunch();
  const p = harness.page;

  // the goal is paused at quit, and nothing set it going again
  await openChatShowing(p, 'fake-codex: keep at it SLOW');
  await expect(await goalCard(p)).toContainText('Paused when MoPilot quit');
  // the Claude chat has its history, and its turn is over
  await openChatShowing(p, 'long job SLOW');
  await expect(transcript(p)).toContainText('pineapple-42');
  await expect(stop(p)).toHaveCount(0);
  await expect(composer(p)).toBeEnabled();
  await p.waitForTimeout(500);
  expect(turnStarts(harness)).toHaveLength(codexBefore);
  expect(claudeUsers(harness)).toHaveLength(claudeBefore);
  expect(
    harness
      .codexLog()
      .slice(logBefore)
      .some((e) => e.method === 'thread/goal/set' && e.params.threadId === threadId && e.params.status === 'active'),
  ).toBe(false);

  // the grant and the setting are kept
  expect(JSON.stringify(await p.evaluate(() => (window as any).native.browser.sites()))).toContain(`127.0.0.1:${port}`);
  expect(await showReasoning(p)).toBe('false');
  // and the chats carry on
  await openChatShowing(p, 'long job SLOW');
  await send(p, 'after the update');
  await expect(transcript(p).getByText('fake-claude: after the update', { exact: true })).toBeVisible();
});

const UPDATE_HOOK = path.join(__dirname, 'fixtures', 'update-hook.cjs');
/** Calls one of the update hook's controls in main (fixtures/update-hook.cjs). */
const hook = (h: Harness, name: string, ...args: unknown[]) =>
  h.app.evaluate((_e, [n, a]) => (globalThis as any).__updateHook[n as string](...(a as unknown[])), [name, args] as const);
/** The stealth restart's wait: a check, `ms` on the hook's clock, and another check (its timer checks every 30 s). */
async function idleFor(h: Harness, ms: number) {
  await hook(h, 'tick');
  await hook(h, 'advance', ms);
  await hook(h, 'tick');
}
const restartFile = (h: Harness) => path.join(h.dir, 'userData', 'restart-view.json');
const hookLog = (h: Harness) => path.join(h.dir, 'userData', 'update-hook.log');
/** The app window (not Quick Chat, nor the browser pane's parking window, which loads no page). */
const appWindow = (h: Harness, act: 'state' | 'minimize' | 'restore') =>
  h.app.evaluate(({ BrowserWindow }, what) => {
    const w = BrowserWindow.getAllWindows().find(
      (x) => x.webContents.getURL().startsWith('file:') && !x.webContents.getURL().includes('#mini'),
    );
    if (!w) return null;
    if (what === 'minimize') w.minimize();
    if (what === 'restore') w.restore();
    return { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() };
  }, act);
const closedNow = (h: Harness) => new Promise<void>((r) => h.app.once('close', () => r()));

test.describe('restart into an update', () => {
  test.use({ mainRequire: [UPDATE_HOOK] });

  test('update-and-migrate: a downloaded update restarts by itself after ten idle, unfocused minutes, never over a running turn or a draft, and reopens the chat as its window was', async ({
    page,
    harness,
  }) => {
    test.setTimeout(120_000);
    await expect(home(page)).toBeVisible();
    // the user's automatic updates are on (Settings → About)
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await page.locator('.side-row', { hasText: 'About' }).click();
    const auto = page.locator('.settings-row', { hasText: 'Update automatically' }).getByRole('switch');
    await auto.click();
    await expect(auto).toHaveAttribute('aria-checked', 'true');
    await page.locator('.side-row', { hasText: 'Back to app' }).click();

    await pickModel(page, 'Codex', 'Fake Model One');
    await send(page, 'ship the fix');
    await expect(transcript(page).getByText('fake-codex: ship the fix', { exact: true })).toBeVisible();
    // an update is downloaded: the sidebar offers the restart
    await hook(harness, 'ready', '9.9.9');
    await expect(sidebar(page).getByRole('button', { name: 'Restart to update' })).toHaveAttribute('title', 'Restart to update · v9.9.9');
    // no window of the app has focus (it runs in the background) all along
    expect(await appWindow(harness, 'state')).toMatchObject({ visible: true, minimized: false, focused: false });

    // a running turn holds the restart, however long the app sits idle
    await send(page, 'long job SLOW');
    await expect(stop(page)).toBeVisible();
    await idleFor(harness, 11 * 60_000);
    expect(await hook(harness, 'status')).toBe('ready');
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0);
    // so does a draft not yet sent
    await composer(page).fill('half-typed thought');
    await page.waitForTimeout(1000);
    await idleFor(harness, 11 * 60_000);
    expect(await hook(harness, 'status')).toBe('ready');
    await composer(page).fill('');
    await page.waitForTimeout(1000);
    // with nothing to lose, not before ten minutes
    await idleFor(harness, 10 * 60_000 - 1000);
    expect(await hook(harness, 'status')).toBe('ready');
    expect(fs.existsSync(restartFile(harness))).toBe(false);
    expect(fs.existsSync(hookLog(harness))).toBe(false);

    // the user minimized the window and left; at ten minutes the app restarts into the update by itself
    await appWindow(harness, 'minimize');
    await expect.poll(() => appWindow(harness, 'state')).toMatchObject({ minimized: true });
    const closed = closedNow(harness);
    await hook(harness, 'advance', 1000);
    await hook(harness, 'tick').catch(() => {});
    await closed;
    expect(fs.readFileSync(hookLog(harness), 'utf8')).toBe('quitAndInstall\n');
    expect(JSON.parse(fs.readFileSync(restartFile(harness), 'utf8'))).toMatchObject({
      chatId: expect.any(String),
      window: { visible: false, minimized: true },
    });
    const before = turnStarts(harness).length;

    await harness.relaunch();
    const p = harness.page;
    // the chat is open again without being picked, its window minimized as it was, and the marker is used up
    await expect(transcript(p).getByText('fake-codex: ship the fix', { exact: true })).toBeVisible();
    await expect(transcript(p).getByText('long job SLOW', { exact: true })).toBeVisible();
    await expect(home(p)).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Select model' })).toContainText('Fake Model One');
    await expect.poll(() => appWindow(harness, 'state')).toMatchObject({ minimized: true, focused: false });
    expect(fs.existsSync(restartFile(harness))).toBe(false);
    await expect(sidebar(p).getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
    // nothing ran by itself; the chat carries on in the same Codex thread
    await p.waitForTimeout(500);
    expect(turnStarts(harness)).toHaveLength(before);
    await appWindow(harness, 'restore');
    await send(p, 'after the restart');
    await expect(transcript(p).getByText('fake-codex: after the restart', { exact: true })).toBeVisible();
    expect(new Set(turnStarts(harness).map((e) => e.params.threadId)).size).toBe(1);
  });

  test('update-and-migrate: a staged restart reopens the Claude Code chat and it carries on', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await pickModel(page, 'Claude Code', 'Fake Sonnet');
    await send(page, 'draft the post');
    await expect(transcript(page).getByText('fake-claude: draft the post', { exact: true })).toBeVisible();
    await hook(harness, 'ready', '9.9.9', true);
    const restart = sidebar(page).getByRole('button', { name: 'Restart to update' });
    await expect(restart).toHaveAttribute('title', 'Restart to update · v9.9.9');

    const closed = closedNow(harness);
    await restart.click();
    await closed;
    expect(fs.readFileSync(hookLog(harness), 'utf8')).toBe('activate:restart\n');
    // the user asked for this restart: only the chat is kept, and the window opens as usual
    const saved = JSON.parse(fs.readFileSync(restartFile(harness), 'utf8'));
    expect(saved.chatId).toEqual(expect.any(String));
    expect(saved.window).toBeUndefined();

    await harness.relaunch();
    const p = harness.page;
    await expect(transcript(p).getByText('fake-claude: draft the post', { exact: true })).toBeVisible();
    await expect(home(p)).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Select model' })).toContainText('Fake Sonnet');
    await expect.poll(() => appWindow(harness, 'state')).toMatchObject({ visible: true, minimized: false });
    expect(fs.existsSync(restartFile(harness))).toBe(false);
    await expect(sidebar(p).getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
    await send(p, 'and publish it');
    await expect(transcript(p).getByText('fake-claude: and publish it', { exact: true })).toBeVisible();
    expect(claudeChatMessages(harness).map(claudeTextOf)).toEqual(['draft the post', 'and publish it']);
  });
});
