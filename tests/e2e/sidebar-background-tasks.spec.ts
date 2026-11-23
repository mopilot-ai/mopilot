// The sidebar keeps a chat's working dot while its background tasks run after its turn ended, as Claude Desktop keeps
// such a session running, and drops it when they settle: on Claude Code (main's tasks) and on Codex (polled by the
// window even after the user left the chat, and counted by main for a window reloaded since). Runs against
// fake-claude.mjs and fake-codex.mjs.
// e2e-covers: src/components/panels/SummaryActivity.tsx src/components/tasks/TaskPolling.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const working = (page: Page) => page.getByRole('complementary').locator('.thread-row .row-dot.working');
// the composer's turn Stop, not a background terminal's own Stop in the side panel
const stop = (page: Page) => page.locator('.send-btn.stop');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('claude', () => {
  test.use({ harnesses: 'claude' });

  test("a Claude Code chat keeps its working dot while its background agent runs, here or away, until it's stopped", async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'start BGTASK auth');
    await expect(page.locator('.tasks-count')).toContainText('1 running task');
    // the turn is over: only the background agent runs
    await expect(stop(page)).toHaveCount(0);
    await expect(working(page)).toHaveCount(1);
    await expect(working(page)).toBeVisible();
    await expect(working(page)).toHaveCSS('animation-name', 'row-dot-pulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(working(page)).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const activeRow = page.getByRole('complementary').locator('.thread-row', { has: page.locator('.row-dot.working') });
    // hovered, the row's menu takes the dot's place right of its PR column
    await activeRow.hover();
    await expect(activeRow.getByRole('button', { name: 'More options' })).toBeVisible();
    await expect(working(page)).toBeHidden();
    // the title shimmer accompanies the visible activity dot
    await expect(page.getByRole('complementary').locator('.thread-row .shimmer-text')).toHaveCount(1);
    // away from the chat, its row still works
    await standaloneNewChat(page).click();
    await expect(home(page)).toBeVisible();
    await expect(working(page)).toHaveCount(1);
    await expect(working(page)).toBeVisible();
    // back in the chat, its tasks count opens its tasks; stopping the agent ends the work
    await activeRow.click();
    await page.locator('.tasks-count').first().click();
    await page.locator('.task-card.running').getByRole('button', { name: 'Stop Explore auth', exact: true }).click();
    await expect(page.locator('.task-card.running')).toHaveCount(0);
    await expect(working(page)).toHaveCount(0);
  });
});

test.describe('codex', () => {
  test.use({ harnesses: 'codex' });

  test('a Codex chat keeps its working dot while its background command runs, and drops it when the command ends with the chat closed', async ({
    page,
  }) => {
    // the command's 12 s, then up to a background read's 30 s
    test.setTimeout(90_000);
    await expect(home(page)).toBeVisible();
    await send(page, 'start the server BGTERM 12s');
    await expect(page.locator('.summary-activity').getByRole('button', { name: /^Background tasks/ })).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    await expect(working(page)).toHaveCount(1);
    await expect(working(page)).toBeVisible();
    // leave the chat: the window keeps reading its tasks, so the dot stays while the command runs ...
    await standaloneNewChat(page).click();
    await expect(home(page)).toBeVisible();
    await expect(working(page)).toHaveCount(1);
    await expect(working(page)).toBeVisible();
    // ... and goes when it ends on its own, at the window's next read of a chat no pane shows (BACKGROUND_POLL_MS, 30 s,
    // in src/store/codexTasks.ts), with a margin for the tick
    await expect(working(page)).toHaveCount(0, { timeout: 45_000 });
  });

  test('after a window reload, a Codex chat whose background command still runs shows its dot without being opened', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'start the server BGTERM 25s');
    await expect(page.locator('.summary-activity').getByRole('button', { name: /^Background tasks/ })).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    await standaloneNewChat(page).click();
    await expect(home(page)).toBeVisible();
    // a reloaded window never polled the chat: main's count of its background work is all it knows
    await page.reload();
    await expect(home(page)).toBeVisible();
    await expect(working(page)).toHaveCount(1);
    await expect(working(page)).toBeVisible();
    // it goes when the command ends, with the chat never opened in this window
    await expect(working(page)).toHaveCount(0, { timeout: 40_000 });
    await expect(home(page)).toBeVisible();
  });
});
