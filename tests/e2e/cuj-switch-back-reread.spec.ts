// #4257: a chat that went Claude Code → Codex → Claude Code is back on the session its id names. Leaving it and coming
// back re-reads that session's latest turns, which must not drop the Codex part shown between its two segments.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { standaloneNewChat } from './fixtures/sidebar';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
/** The user's own message: the fakes echo it, and a later handoff quotes it, so its text alone is not one element */
const bubble = (page: Page, text: string) => transcript(page).locator('.fold-text', { hasText: new RegExp(`^${text}$`) });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function pick(page: Page, name: string, model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: name }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).first().click();
}

async function idle(page: Page, chat: string) {
  await expect
    .poll(() => page.evaluate((id) => window.native.session.snapshot(id), chat), { timeout: 60_000 })
    .toMatchObject({ turn: 'idle' });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}

test.use({ harnesses: 'both' });

test('a chat back on its own Claude Code session keeps the Codex part when it is re-read', async ({ page }) => {
  test.setTimeout(180_000);
  await pick(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'first on claude');
  await expect(transcript(page).getByText('fake-claude: first on claude', { exact: true })).toBeVisible();
  const chat = (await page.locator('.thread-view').getAttribute('data-thread-id'))!;
  await idle(page, chat);

  await pick(page, 'Codex', '');
  await expect(page.locator('.switch-chip')).toBeVisible();
  await send(page, 'second on codex');
  // the fake echoes its whole input, the handoff first, a few characters a tick
  await expect(transcript(page).getByText('fake-codex: <sage-handoff', { exact: false })).toBeVisible({ timeout: 60_000 });
  await idle(page, chat);

  await pick(page, 'Claude Code', 'Fake Sonnet');
  await expect(page.locator('.switch-chip')).toBeVisible();
  await send(page, 'third on claude');
  await expect(bubble(page, 'third on claude')).toBeVisible();
  await idle(page, chat);
  const codexPart = bubble(page, 'second on codex');
  await expect(codexPart).toBeVisible();

  // away and back: the chat is shown again and its Claude Code transcript is re-read
  await standaloneNewChat(page).click();
  await expect(page.locator('.thread-view')).toHaveCount(0);
  await page.locator(`[data-sidebar-chat="${chat}"]`).click();
  await expect(bubble(page, 'third on claude')).toBeVisible();
  // The re-read lands after the chat is shown, and the turn it reads back comes from the session file with its read-back
  // id ("h-<uuid>", src/store/stoppedByYou.ts) where the live one was "ct-<uuid>": wait for that, then check every part
  // is there (before #4257 this is where the Codex part went: the base fails here, which shows the re-read ran).
  const slots = transcript(page).locator('[data-turn-slot]');
  await expect(slots.last()).toHaveAttribute('data-turn-slot', /^h-/);
  // A long chat renders in full only the turns near the viewport (thread/view/turnWindow.tsx); the rest are placeholders
  // until the reader scrolls to them. On a short window (the Windows runner's display is 1024x768) the first turn, above
  // two long handoff turns, is one of them. So: the three turns are all there, in order, each shown once scrolled to.
  await expect(slots).toHaveCount(3);
  const parts = ['first on claude', 'second on codex', 'third on claude'];
  for (const [i, text] of parts.entries()) {
    await slots.nth(i).scrollIntoViewIfNeeded();
    await expect(slots.nth(i).locator('.fold-text', { hasText: new RegExp(`^${text}$`) })).toBeVisible();
  }
});
