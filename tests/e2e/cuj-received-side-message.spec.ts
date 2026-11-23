// A session a chat started messages its parent while the parent is idle: the delivered message reads in the parent's
// transcript as a closed "Received message from <session>" row (Claude Desktop 4.29.0's), its toggle shows and hides
// the text, two messages back to back are two rows with a choice each, and what was opened survives leaving the chat
// and coming back.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const BRIEF =
  'This independent linked task belongs to the user’s current request. Preserve its assigned scope and report its own result to the parent session.';

const journal = (h: Harness): any => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8'));
  } catch {
    return { children: {}, deliveries: {} };
  }
};
const messages = (h: Harness): any[] => Object.values<any>(journal(h).deliveries ?? {}).filter((d) => d.kind === 'message');

test.use({ harnesses: 'claude' });

test('a message from a session the chat started is a closed row until opened, and stays as the user left it', async ({
  page,
  harness,
}, testInfo) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();

  const folder = path.join(harness.dir, 'home', 'work', 'received-project');
  fs.mkdirSync(folder, { recursive: true });
  await harness.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any;
  }, folder);
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(page.locator('.ctxbar')).toContainText('received-project');

  // the child's first acts are two messages to its parent, whose own turn is over
  const start = `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    title: 'Message worker',
    prompt: `CUSTEPS\nCUCALL send_message ${JSON.stringify({ to: 'parent', message: 'Blocked on the schema' })}\nCUCALL send_message ${JSON.stringify({ to: 'parent', message: 'Schema is unblocked now' })}`,
    background: BRIEF,
  })}`;
  await composer(page).fill(`Start a session CUSTEPS\n${start}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => messages(harness).length, { timeout: 60_000 }).toBe(2);

  const rows = page.getByRole('main').locator('.side-session-card[data-kind="message"]');
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  // The child's idle turn wakes the parent ("The app asked Claude Code to report back"), whose reply streams in while
  // the transcript follows the bottom: a toggle clicked then moves between press and release, and the click lands on
  // the row around it (Windows E2E). The rows are toggled once that reply has finished and shown all of its text.
  const wake = page
    .getByRole('main')
    .locator('.main-content .turn')
    .filter({ has: page.locator('.side-session-card[data-kind="wake"]') });
  await expect(wake.getByRole('button', { name: 'Fork chat from here', exact: true })).toBeVisible({ timeout: 60_000 });
  const transcript = page.getByRole('region', { name: 'Conversation transcript' });
  let height = -1;
  await expect
    .poll(
      async () => {
        const now = await transcript.evaluate((el) => el.scrollHeight);
        const still = now === height;
        height = now;
        return still;
      },
      { intervals: [400] },
    )
    .toBe(true);
  const first = rows.nth(0);
  const second = rows.nth(1);

  // closed: who sent it, a toggle by the sender's name, no message text (the fake titles every chat "Fake chat title")
  await expect(first.locator('.side-session-note-head span')).toHaveText('Received message from Fake chat title');
  const firstToggle = first.getByRole('button', { name: 'Show message from Fake chat title' });
  await expect(firstToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(first.locator('.side-session-text')).toHaveCount(0);
  // never the raw envelope (the fake assistant's own echo of its input is outside the row)
  await expect(first).not.toContainText('mopilot-side-session-message');
  await page.screenshot({ path: testInfo.outputPath('received-message-closed.png') });

  // opening one leaves the other closed
  await firstToggle.click();
  await expect(first.locator('.side-session-text')).toHaveText('Blocked on the schema');
  await expect(first.getByRole('button', { name: 'Hide message from Fake chat title' })).toHaveAttribute('aria-expanded', 'true');
  await expect(second.locator('.side-session-text')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('received-message-open.png') });

  // leaving the chat and coming back keeps the first open and the second closed
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await sidebar(page).locator('.thread-row:not(.linked-child)', { hasText: 'Fake chat title' }).first().click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.side-session-text')).toHaveText('Blocked on the schema');
  await expect(rows.nth(1).locator('.side-session-text')).toHaveCount(0);

  // closing it again, and opening the second
  await rows.nth(0).getByRole('button', { name: 'Hide message from Fake chat title' }).click();
  await expect(rows.nth(0).locator('.side-session-text')).toHaveCount(0);
  await rows.nth(1).getByRole('button', { name: 'Show message from Fake chat title' }).click();
  await expect(rows.nth(1).locator('.side-session-text')).toHaveText('Schema is unblocked now');
  await page.screenshot({ path: testInfo.outputPath('received-message-second-open.png') });
});
