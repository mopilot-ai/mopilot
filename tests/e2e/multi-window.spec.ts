// Two windows on one chat (A15): the send queue lives only in main (electron/session/controller.cjs),
// so a message queued from either window is sent once, and both windows show the same state.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
// queued messages are listed above the composer
const queued = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: text });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Every turn/start the app sent for a chat thread (not the hidden title helpers), in order. */
function turnStarts(h: Harness) {
  return h
    .codexLog()
    .filter((e) => e.method === 'turn/start' && !/short chat title/.test(e.params.input?.[0]?.text ?? ''))
    .map((e) => ({ threadId: e.params.threadId as string, text: e.params.input.map((i: any) => i.text).join('') }));
}

test('multi-window: a message queued in a second window while a SLOW turn runs is sent exactly once', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'take it SLOW');
  await expect(transcript(page).getByText('fake-codex: take it SLOW', { exact: true })).toBeVisible();
  await expect.poll(() => turnStarts(harness).length).toBe(1);
  const [{ threadId }] = turnStarts(harness);

  // a second window on the same chat sees the running turn as this app's, not another app's
  const opened = harness.app.waitForEvent('window');
  await page.evaluate((id) => (window as any).native.win.open(`thread=${id}`), threadId);
  const page2 = await opened;
  await expect(transcript(page2).getByText('fake-codex: take it SLOW', { exact: true })).toBeVisible();
  await expect(page2.getByRole('button', { name: 'Stop' })).toBeVisible();

  await send(page2, 'queued from the second window');
  // main holds the queue: both windows show it, and nothing more went to the app-server
  for (const p of [page, page2]) await expect(queued(p, 'queued from the second window')).toBeVisible();
  expect(turnStarts(harness).map((t) => t.text)).toEqual(['take it SLOW']);

  // the slow turn finishes: the queued message goes out once, and both windows show its reply
  fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');
  for (const p of [page, page2]) {
    await expect(transcript(p).getByText('fake-codex: queued from the second window', { exact: true })).toBeVisible();
    await expect(queued(p, 'queued from the second window')).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  }
  await page.waitForTimeout(500);
  expect(turnStarts(harness)).toEqual([
    { threadId, text: 'take it SLOW' },
    { threadId, text: 'queued from the second window' },
  ]);
  // the same state in both windows: idle, nothing queued
  const states = await Promise.all([page, page2].map((p) => p.evaluate((id) => (window as any).native.session.snapshot(id), threadId)));
  for (const s of states) expect(s).toMatchObject({ turn: 'idle', queue: [], activeTurn: null });
});

test('multi-window: plan mode is the chat’s, so a second window shows it too', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-codex: hello', { exact: true })).toBeVisible();
  const [{ threadId }] = turnStarts(harness);
  await composer(page).fill('/plan');
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-chip')).toBeVisible();

  const opened = harness.app.waitForEvent('window');
  await page.evaluate((id) => (window as any).native.win.open(`thread=${id}`), threadId);
  const page2 = await opened;
  await expect(page2.locator('.plan-chip')).toBeVisible();
  // turning it off in one window turns it off in the other
  await page2.locator('.plan-chip').click();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
});

test.describe('approval cards', () => {
  test.use({ harnesses: 'claude' });
  test('multi-window: a window opened after the request shows its approval card, and an answer in either closes both', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'RUNCMD first');
    const card = (p: Page) => p.locator('.approval-card');
    await expect(card(page)).toContainText('Allow Claude Code to run this command?');
    const [threadId] = await page.evaluate(() => (window as any).native.session.withApprovals());
    expect(threadId).toBeTruthy();

    // opened after the request came in: it never saw the event, only main's SessionState
    const opened = harness.app.waitForEvent('window');
    await page.evaluate((id) => (window as any).native.win.open(`thread=${id}`), threadId);
    const page2 = await opened;
    await expect(card(page2)).toContainText('Allow Claude Code to run this command?');
    await expect(card(page2).locator('.approval-cmd')).toHaveText('npm test');
    await card(page2)
      .getByRole('button', { name: /Allow once/ })
      .click();
    await expect(card(page2)).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    await expect(transcript(page).getByText(/fake-claude: RUNCMD first \[command: ran\]/)).toBeVisible();
  });
});
