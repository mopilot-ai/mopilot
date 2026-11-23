// Harness translation in main (docs/architecture/rust-core.md §2, `session` step): a Claude Code chat and a basic (ACP)
// chat show a reply once, also while another window has the chat in the background (the stream batcher's slow lane sends
// its deltas again), a window reloaded mid-turn shows the running turn and can stop it, a CLI that quits ends the turn with
// one message, and a restart reads the chat back.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatProcesses } from './fixtures/claudeChat';
import { standaloneNewChat } from './fixtures/sidebar';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const CLAUDE_CRASHED = /^Claude Code (quit while working|process terminated by signal SIGKILL)/;

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The chat's id, from its sidebar row. */
async function chatId(page: Page, prefix: string) {
  const row = page.getByRole('complementary').locator(`[data-sidebar-chat^="${prefix}"]`).first();
  await expect(row).toBeVisible();
  return (await row.getAttribute('data-sidebar-chat'))!;
}

/** A second window on Home, so the chat is in its background: it gets the chat's deltas on the batcher's slow lane. */
async function backgroundWindow(h: Harness, page: Page, id: string) {
  const opened = h.app.waitForEvent('window');
  await page.evaluate((chat) => (window as any).native.win.open(`thread=${chat}`), id);
  const other = await opened;
  await standaloneNewChat(other).click();
  await expect(home(other)).toBeVisible();
  return other;
}

/**
 * A SLOW turn sends its whole reply as one delta and waits: the reply shows once in the window showing the chat while a
 * second window has it in the background, and Stop ends it.
 */
async function slowTurnShownOnce(h: Harness, page: Page, idPrefix: string, reply: string) {
  await send(page, 'warm up');
  const id = await chatId(page, idPrefix);
  const other = await backgroundWindow(h, page, id);
  await send(page, 'take it SLOW');
  await expect(transcript(page).getByText(`${reply}: take it SLOW`, { exact: true })).toBeVisible();
  // a second translation of the slow lane's copy would read "...SLOW...SLOW" here until the turn ends
  await page.waitForTimeout(500);
  await expect(transcript(page).getByText(`${reply}: take it SLOW`, { exact: true })).toBeVisible();
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  await other.close();
}

/**
 * A window reloaded while a SLOW turn runs (it opens on Home) shows that turn running when the chat is opened again, with
 * its message once, and its Stop ends it. Text streamed before the reload is not in a Claude Code transcript until its
 * message ends, so a reopened window shows it then, as it did when each window translated.
 */
async function reloadMidTurn(page: Page, idPrefix: string, reply: string) {
  await send(page, 'reload me SLOW');
  await expect(transcript(page).getByText(`${reply}: reload me SLOW`, { exact: true })).toBeVisible();
  const id = await chatId(page, idPrefix);
  await page.reload();
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${id}"]`).click();
  await expect(transcript(page).getByText('reload me SLOW', { exact: true })).toHaveCount(1);
  await expect(stop(page)).toBeVisible();
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
}

test.describe('Claude Code, translated in main', () => {
  test.use({ harnesses: 'claude' });

  test('a reply once with the chat in another window, a reload and a quit mid-turn, then a restart', async ({ harness }) => {
    let page = harness.page;
    await expect(home(page)).toBeVisible();
    await slowTurnShownOnce(harness, page, 'claude:', 'fake-claude');
    await reloadMidTurn(page, 'claude:', 'fake-claude');

    // the CLI dies mid-turn: the turn ends, saying so once
    await send(page, 'quit on me SLOW');
    await expect(transcript(page).getByText('fake-claude: quit on me SLOW', { exact: true })).toBeVisible();
    // the chat's own CLI, not a helper that saw the same text (claudeChat.ts)
    const chats = claudeChatProcesses(harness);
    const cli = harness.claudeLog().find((e) => e.kind === 'in' && chats.has(e.pid) && JSON.stringify(e.msg).includes('quit on me SLOW'))!;
    process.kill(cli.pid, 'SIGKILL');
    await expect(transcript(page).getByText(CLAUDE_CRASHED)).toBeVisible();
    await expect(stop(page)).toHaveCount(0);

    // a restart reads the chat back from its transcript
    const id = await chatId(page, 'claude:');
    await harness.relaunch();
    page = harness.page;
    await expect(home(page)).toBeVisible();
    await page.getByRole('complementary').locator(`[data-sidebar-chat="${id}"]`).click();
    await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText('warm up', { exact: true })).toHaveCount(1);
  });
});

test.describe('a basic harness, translated in main', () => {
  // a basic harness is admitted only with sage-mcp, which builds only on macOS, so the PR check runs this spec on its
  // macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
  test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
  test.use({ harnesses: 'none', acp: { kimi: {} } });

  test('a reply once with the chat in another window, a reload mid-turn, then a restart', async ({ harness }) => {
    let page = harness.page;
    await expect(home(page)).toBeVisible();
    await slowTurnShownOnce(harness, page, 'acp:kimi:', 'fake-acp');
    await reloadMidTurn(page, 'acp:kimi:', 'fake-acp');

    const id = await chatId(page, 'acp:kimi:');
    await harness.relaunch();
    page = harness.page;
    await expect(home(page)).toBeVisible();
    await page.getByRole('complementary').locator(`[data-sidebar-chat="${id}"]`).click();
    await expect(transcript(page).getByText('fake-acp: warm up', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText('warm up', { exact: true })).toHaveCount(1);
  });
});
