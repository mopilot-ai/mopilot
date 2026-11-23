// A Claude Code chat with a linked session gets an image-only message: the hidden linked-sessions block is the whole text the CLI stores, and neither the live bubble nor the bubble replayed from the transcript after a restart shows it.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages } from './fixtures/claudeChat';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const HIDDEN = /sage-linked-sessions|Linked sessions now/;
// a 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Attach an image through the + menu, the way a user picks a file. */
async function attachImage(page: Page, h: Harness) {
  const file = path.join(h.dir, 'sketch.png');
  fs.writeFileSync(file, PNG);
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, file);
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Files and folders', { exact: true }).click();
  await expect(page.locator('.attachment.image')).toHaveCount(1);
}

/** Every user bubble's text in the open chat. */
const bubbles = (page: Page) => transcript(page).locator('.user-message').allInnerTexts();

test.use({ harnesses: 'both' });

test('an image-only message to a chat with a linked session never shows the hidden roster block, live or replayed', async ({
  page,
  harness,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();

  // the agent starts one linked session; its turn is held (SLOW as a JSON escape, so the parent's own turn is not), so
  // main never wakes the parent and the roster stays unseen by it until the user's next message
  const start = `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    harness: 'claude',
    title: 'ROSTER-child notes',
    prompt: 'Draft the notes SLOW',
    background:
      'This independent session drafts the notes requested by the user; preserve its assigned files and report the outcome to its parent.',
  }).replace(/SLOW/g, 'SL\\u004fW')}`;
  await composer(page).fill(['start one linked session for the notes', start].join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(/fake-claude: start one linked session/)).toBeVisible();
  await expect(sidebar(page).getByRole('group', { name: 'Sessions this chat started' }).locator('.thread-row')).toHaveCount(1);
  const chatId = await page.locator('.thread-view').getAttribute('data-thread-id');
  expect(chatId).toBeTruthy();

  // the user's next message is only an image: no text at all
  await attachImage(page, harness);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.attachment.image')).toHaveCount(0);
  await expect(transcript(page).locator('.user-message')).toHaveCount(2);
  // the CLI stored the roster block as the message's text, so this is the case the bug needs
  await expect
    .poll(() => JSON.stringify(claudeChatMessages(harness).at(-1)?.message?.content ?? ''), { timeout: 30_000 })
    .toContain('<sage-linked-sessions>');
  for (const text of await bubbles(page)) expect(text).not.toMatch(HIDDEN);

  // restart: the chat is read back from the CLI's transcript, which holds the image message trimmed to its block
  await harness.relaunch();
  const reopened = harness.page;
  await sidebar(reopened).locator(`[data-sidebar-chat="${chatId}"]`).first().click();
  await expect(reopened.locator('.thread-view')).toHaveAttribute('data-thread-id', chatId!);
  await expect(transcript(reopened).getByText(/fake-claude: start one linked session/)).toBeVisible();
  await expect(transcript(reopened).locator('.user-message')).toHaveCount(2);
  for (const text of await bubbles(reopened)) expect(text).not.toMatch(HIDDEN);
});
