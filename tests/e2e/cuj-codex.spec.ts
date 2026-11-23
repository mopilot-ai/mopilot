// Critical user journeys on the Codex harness, run in the real app against tests/e2e/fixtures/fake-codex.mjs.
import { standaloneNewChat, archiveSidebarChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');
/** Idle: no Stop button, and the empty composer shows Dictate (macOS), a voice conversation, or a disabled Send. */
async function expectIdle(page: Page) {
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Dictate|Send|Voice conversation)$/ }).first()).toBeVisible();
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The (non-ephemeral) chat threads the app started, and every turn/start it sent to each. */
function chatTurns(h: Harness) {
  const log = h.codexLog();
  const helpers = new Set<string>();
  const turns = new Map<string, string[]>();
  // the fake answers thread/start with ids the log can't see, so key turns by their threadId and
  // drop the app's hidden title helpers (ephemeral threads asking for a title)
  for (const e of log)
    if (e.method === 'turn/start' && /as a short chat title/.test(e.params.input?.[0]?.text ?? '')) helpers.add(e.params.threadId);
  for (const e of log) {
    if (e.method !== 'turn/start' || helpers.has(e.params.threadId)) continue;
    const text = e.params.input.map((i: any) => i.text).join('');
    turns.set(e.params.threadId, [...(turns.get(e.params.threadId) ?? []), text]);
  }
  return turns;
}

test('first-launch-harness-detect: a signed-in Codex opens the main view', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Codex' })).toHaveCount(0);
  // the fake's models reached the model picker
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake Model One');
  await expect
    .poll(() => harness.codexLog().map((e) => e.method))
    .toEqual(expect.arrayContaining(['initialize', 'initialized', 'account/read', 'model/list', 'thread/list']));
});

test('daily-chat-loop: send two messages and see the streamed replies', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello from e2e');
  await expect(transcript(page).getByText('fake-codex: hello from e2e', { exact: true })).toBeVisible();
  await expectIdle(page);

  await send(page, 'and a second message');
  await expect(transcript(page).getByText('fake-codex: and a second message', { exact: true })).toBeVisible();

  const turns = chatTurns(harness);
  expect([...turns.values()]).toEqual([['hello from e2e', 'and a second message']]);
});

test('daily-chat-loop stop: Stop interrupts a running turn and the chat goes idle', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'take it SLOW');
  await expect(transcript(page).getByText('fake-codex: take it SLOW', { exact: true })).toBeVisible();
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await stop.click();

  await expectIdle(page);
  const [threadId] = [...chatTurns(harness).keys()];
  const interrupts = harness.codexLog().filter((e) => e.method === 'turn/interrupt');
  expect(interrupts).toHaveLength(1);
  expect(interrupts[0].params.threadId).toBe(threadId);
});

test('manage-search-archive: rename a chat, find it, then archive it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'a chat to rename');
  await expect(transcript(page).getByText('fake-codex: a chat to rename', { exact: true })).toBeVisible();
  // the fake answers the app's title helper with a fixed title
  const row = sidebar(page).getByText('Fake chat title', { exact: true });
  await expect(row).toBeVisible();

  await row.dblclick();
  const input = sidebar(page).getByRole('textbox');
  await input.fill('Renamed by e2e');
  await input.press('Enter');
  const renamed = sidebar(page).getByText('Renamed by e2e', { exact: true });
  await expect(renamed).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(
    harness
      .codexLog()
      .filter((e) => e.method === 'thread/name/set')
      .map((e) => e.params.name),
  ).toContain('Renamed by e2e');

  await sidebar(page).getByRole('button', { name: 'Search' }).click();
  await page.getByPlaceholder('Search chats').fill('renamed');
  await expect(page.locator('.palette-title', { hasText: 'Renamed by e2e' })).toBeVisible();
  await expect.poll(() => harness.codexLog().some((e) => e.method === 'thread/list' && e.params.searchTerm === 'renamed')).toBe(true);
  await page.keyboard.press('Escape');

  await renamed.hover();
  await archiveSidebarChat(page, sidebar(page));
  await expect(renamed).toHaveCount(0);
  await expect(home(page)).toBeVisible();
  expect(harness.codexLog().filter((e) => e.method === 'thread/archive')).toHaveLength(1);
});

test('new-chat-default-harness: New chat opens an empty Codex composer', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'leave this chat');
  await expect(transcript(page).getByText('fake-codex: leave this chat', { exact: true })).toBeVisible();
  await expect(home(page)).toHaveCount(0);

  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await expect(composer(page)).toHaveText('');
  await expect(composer(page)).toBeEditable();
  // the default harness is Codex: its models are on offer
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake Model One');
  await expect(transcript(page).getByText('fake-codex: leave this chat')).toHaveCount(0);
});
