// CUJ side-chat-fork-selection on both harnesses: select a passage of a reply and ask about it in a side chat (a fork of
// the chat that runs next to it and leaves the main chat alone), add a passage to the main composer, and fork the whole
// chat from the title bar. Codex forks an ephemeral thread; Claude Code forks the session.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { selectCompletedReply } from './fixtures/replySelection';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true }).first();
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const pane = (page: Page) => page.locator('.side-pane');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}

async function journey(page: Page, harness: Harness, fake: string) {
  await send(page, 'explain the retry loop');
  const reply = `${fake}: explain the retry loop`;
  await expect(transcript(page).getByText(reply, { exact: true })).toBeVisible();

  // select a passage: "Start a side chat" opens a chat next to this one, with the passage attached
  await selectCompletedReply(page, reply);
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  await page.locator('.selection-toolbar').getByRole('button', { name: 'Start a side chat' }).click();
  await expect(pane(page)).toBeVisible();
  await expect(page.locator('.tb-tab', { hasText: 'Side chat' })).toBeVisible();
  const side = pane(page).getByRole('textbox', { name: 'Message', exact: true });
  await expect(pane(page).locator('.selection-chip')).toContainText('1 selection');
  await side.fill('what does this mean');
  await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane(page).getByText(new RegExp(`${fake}: [\\s\\S]*what does this mean`))).toBeVisible();

  // A chat-owned follow-up stays with the side chat, even while the main composer has focus.
  await composer(page).fill('keep my main draft');
  await side.fill('suggest next\n\n:codex-followup[Continue here]{prompt="Continue in this side chat"}');
  await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
  const followup = pane(page).getByRole('button', { name: 'Continue here', exact: true });
  await expect(followup).toBeVisible();
  await side.fill('keep my side draft');
  await composer(page).focus();
  await followup.click();
  await expect(side).toHaveText('keep my side draft\nContinue in this side chat');
  await expect(composer(page)).toHaveText('keep my main draft');

  // "Reply": the passage goes into the main composer as an attachment, and travels with the next message
  await selectCompletedReply(page, reply);
  await page.locator('.selection-toolbar').getByRole('button', { name: 'Reply' }).click();
  // Reply makes a numbered annotation of the passage (#320)
  await expect(page.locator('.selection-chip').first()).toContainText('1 annotation');
  await send(page, 'and how do I stop it');
  await expect(
    transcript(page)
      .getByText(/and how do I stop it/)
      .first(),
  ).toBeVisible();

  // Fork into new chat (title bar menu): a second chat in the sidebar starts from this one
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.locator('.menu-item', { hasText: /^Fork$/ }).click();
  await page.locator('.menu-item', { hasText: 'Fork into new chat' }).click();
  await expect(page.getByText('Forked into a new chat')).toBeVisible();
  await expect(transcript(page).getByText(reply, { exact: true }).first()).toBeVisible();
  await expect(sidebar(page).getByText('Fake chat title', { exact: false }).first()).toBeVisible();
}

test.use({ harnesses: 'both' });

test('side-chat-fork-selection on Codex: ask in a side chat, add a passage to the chat, fork the chat', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await journey(page, harness, 'fake-codex');
  // the side chat was an ephemeral fork; the new chat a normal one
  const forks = harness.codexLog().filter((e) => e.method === 'thread/fork');
  expect(forks.some((e) => e.params.ephemeral === true)).toBe(true);
  expect(forks.some((e) => !e.params.ephemeral)).toBe(true);
});

test('side-chat-fork-selection on Claude Code: ask in a side chat, add a passage to the chat, fork the chat', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await journey(page, harness, 'fake-claude');
});
