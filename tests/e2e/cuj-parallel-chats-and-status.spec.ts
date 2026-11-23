// CUJ parallel-chats-and-status: a Codex chat and a Claude Code chat run at once; the sidebar shows one working and one awaiting approval, the approval is answered in its own chat without touching the other, and the finished chat is marked unread and notified.
// Working titles shimmer alongside 8px activity dots; waiting and unread use the same size. A project with many chats folds as Claude Code's lists do.
// e2e-covers: src/components/sidebar/useRequiredChats.ts src/components/sidebar/chatWindow.ts src/components/sidebar/WindowFoot.tsx
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/ChatLists.tsx
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';
import { chooseSetting, settingsEntry } from './fixtures/settings';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.approval-card');
/** The sidebar's status marks on chat rows (ThreadIndicators), and the row that has one: both chats carry the fake's title. */
const status = (page: Page, name: string) => page.getByRole('complementary').locator('.thread-row').getByRole('img', { name, exact: true });
const withStatus = (page: Page, name: string) =>
  page
    .getByRole('complementary')
    .locator('.thread-row')
    .filter({ has: page.getByRole('img', { name, exact: true }) });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function newChatOn(page: Page, who: 'Codex' | 'Claude Code', model: string) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
/** Records the OS notifications main shows (their titles and bodies), instead of showing them. */
async function recordNotifications(h: Harness) {
  await h.app.evaluate(({ Notification }) => {
    const g = globalThis as any;
    g.__notes = [];
    Notification.prototype.show = function (this: any) {
      g.__notes.push({ title: this.title, body: this.body });
    };
  });
  return () => h.app.evaluate(() => (globalThis as any).__notes as { title: string; body: string }[]);
}
/** Settings → Notifications → Always, so a chat on screen is notified too (as notifications.spec does). */
async function notifyAlways(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await chooseSetting(page, 'Notifications', 'Always');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  // the setting reaches the main process with the next (debounced) save
  await page.waitForTimeout(500);
}

test.use({ harnesses: 'both', seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

test('parallel-chats-and-status: a Codex and a Claude Code chat at once, the sidebar status of each, the approval in its own chat, the finished one notified', async ({
  page,
  harness,
}, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(home(page)).toBeVisible();
  const notes = await recordNotifications(harness);
  await notifyAlways(page);

  // 1. a long Codex turn, then a Claude Code turn that asks to run a command
  await newChatOn(page, 'Codex', 'Fake Model One');
  await send(page, 'SLOW codex work');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await newChatOn(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'RUNCMD claude work');
  await expect(card(page)).toContainText('Allow Claude Code to run this command?', { timeout: 30_000 });

  // 2. the sidebar says which is working and which waits on the user
  await expect(status(page, 'Working')).toHaveCount(1);
  await expect(status(page, 'Awaiting approval')).toHaveCount(1);
  // Working keeps a visible dot alongside the title shimmer, including in a narrow window with larger chat text.
  const workingRow = withStatus(page, 'Working');
  const workingTitle = workingRow.locator('.side-row-label .shimmer-text');
  await expect(workingTitle).toBeVisible();
  // the sweep is the band the title's glyphs mask (ShimmerBand), moved by a composited translate every 3s
  const sweep = () =>
    workingTitle.locator('.shimmer-band').evaluate((band) => {
      const s = getComputedStyle(band, '::after');
      return `${s.animationName} ${s.animationDuration}`;
    });
  await expect.poll(sweep).toBe('shimmer-band 3s');
  await expect(status(page, 'Working')).toBeVisible();
  await expect(status(page, 'Working')).toHaveClass(/\brow-dot working\b/);
  await expect(status(page, 'Working')).toHaveCSS('width', '8px');
  await expect(status(page, 'Working')).toHaveCSS('height', '8px');
  await expect(status(page, 'Working')).toHaveCSS('animation-name', 'row-dot-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(status(page, 'Working')).toBeVisible();
  await expect(status(page, 'Working')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(status(page, 'Awaiting approval')).toHaveClass(/\brow-dot waiting\b/);
  await expect(status(page, 'Awaiting approval')).toHaveCSS('width', '8px');
  await expect(status(page, 'Awaiting approval')).toHaveCSS('height', '8px');
  await expect(page.getByRole('complementary').getByText('Awaiting approval')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('sidebar-activity-dots.png') });

  // 3. the Codex chat shows no card; the approval is answered in the Claude chat and only that turn goes on
  await withStatus(page, 'Working').click();
  await expect(transcript(page).getByText('SLOW codex work').first()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await withStatus(page, 'Awaiting approval').click();
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-claude: RUNCMD claude work \[command: ran\]/)).toBeVisible();
  await expect(status(page, 'Awaiting approval')).toHaveCount(0);
  await expect(status(page, 'Working')).toHaveCount(1);

  // 4. the Codex turn finishes while the user is on the Claude chat: marked unread, and notified
  fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');
  await expect(status(page, 'Unread result')).toHaveCount(1, { timeout: 30_000 });
  // unread is a blue dot
  await expect(status(page, 'Unread result')).toHaveClass(/\brow-dot unread\b/);
  await expect(status(page, 'Unread result')).toHaveCSS('width', '8px');
  await expect(status(page, 'Unread result')).toHaveCSS('height', '8px');
  await expect(status(page, 'Unread result')).toHaveCSS('background-color', 'rgb(42, 120, 214)');
  await expect.poll(async () => (await notes()).length).toBeGreaterThan(0);
  await withStatus(page, 'Unread result').click();
  await expect(transcript(page).getByText(/fake-codex: SLOW codex work/)).toBeVisible();
  await expect(status(page, 'Unread result')).toHaveCount(0);
});

/** Twelve chats in one project, newest first. */
const FOLD = Array.from({ length: 12 }, (_, i) => `Fold chat ${String(i + 1).padStart(2, '0')}`);

test.describe('a project with twelve chats', () => {
  test.use({
    harnesses: 'both',
    seed: {
      codexThreads: FOLD.map((name, i) => ({
        id: `019b0000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`,
        cwd: 'work/fold',
        name,
        turns: [name.toLowerCase()],
      })),
      files: ({ home, userData }) => {
        fs.mkdirSync(path.join(home, 'work', 'fold'), { recursive: true });
        fs.writeFileSync(
          path.join(userData, 'projects.json'),
          JSON.stringify({ projects: [{ id: 'fold', name: 'fold', path: path.join(home, 'work', 'fold') }] }),
        );
      },
    },
  });

  test('the project folds as Claude Code lists do: five, five more, the rest, Show less; an open chat near the end holds it', async ({
    page,
  }) => {
    const group = page
      .getByRole('complementary')
      .locator('.project-group')
      .filter({ has: page.locator('.project-row .side-row-label', { hasText: /^fold$/ }) });
    const rows = group.locator('.thread-row .side-row-label');
    const foot = group.locator('.show-more');
    await expect(rows).toHaveText(FOLD.slice(0, 5), { timeout: 30_000 });
    await expect(foot).toHaveText('Show 5 more');
    await foot.click();
    await expect(rows).toHaveText(FOLD.slice(0, 10));
    // the last page takes what is left
    await expect(foot).toHaveText('Show 2 more');
    await foot.click();
    await expect(rows).toHaveText(FOLD);
    await expect(foot).toHaveText('Show less');
    await expect(foot).not.toHaveAttribute('aria-disabled', 'true');

    // the oldest chat open: folding would hide it, so Show less is held and says why
    await group.locator('.thread-row', { hasText: FOLD[11] }).click();
    await expect(page.getByRole('main').getByText(`fake-codex: ${FOLD[11].toLowerCase()}`, { exact: true })).toBeVisible();
    await expect(foot).toHaveAttribute('aria-disabled', 'true');
    await expect(foot).toHaveAttribute('title', 'You have a session open or active near the end of this list.');
    // held: a click does nothing
    await foot.click({ force: true });
    await expect(rows).toHaveCount(12);

    // the newest open instead: Show less folds back to five, and opening a chat never unfolds the whole project
    await group.locator('.thread-row', { hasText: FOLD[0] }).click();
    await expect(foot).not.toHaveAttribute('aria-disabled', 'true');
    await foot.click();
    await expect(rows).toHaveText(FOLD.slice(0, 5));
    await expect(foot).toHaveText('Show 5 more');
  });
});
