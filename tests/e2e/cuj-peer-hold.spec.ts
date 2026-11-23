// CUJ peer-hold (docs/multi-harness/CROSS-SESSION-MESSAGING.md, "Receiver-side hold and loop bounds"): a Claude Code chat
// that asks before acting messages a Codex chat in Full access. The message waits for the receiving user, as Claude
// Code holds a cross-session message from a session in another permission class. Both cards say so; Allow delivers it
// and its reply comes back, and Decline ends another without its body ever reaching the receiving harness.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { PEER_REASONS } from '../../shared/peerReasons.mjs';
import { ask, card, chat, codexLogin, home, journal, send, sidebar, transcript } from './fixtures/peerChats';

const permButton = (page: Page) => page.getByRole('button', { name: 'Change permissions' });

/** What the fake Codex was given as a turn's input, or as a steer into one. */
const codexGot = (h: Harness, body: string) =>
  h.codexLog().some((e) => (e.method === 'turn/start' || e.method === 'turn/steer') && JSON.stringify(e.params).includes(body));

test.use({ harnesses: 'both', seed: codexLogin });

test('a message from a stricter chat waits for the Full access chat’s user: Allow delivers it, Decline ends one', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  // the receiver runs without asking
  const reviewer = await chat(page, harness, 'Codex', 'ready to review', 'Reviewer');
  await permButton(page).click();
  await page.locator('.perm-menu .perm-item.full-access').click();
  await send(page, 'apply full access');
  await expect(transcript(page).getByText('fake-codex: apply full access', { exact: true })).toBeVisible();
  await expect(permButton(page)).toContainText('Full access');
  // the sender asks before acting
  await chat(page, harness, 'Claude Code', 'drafting the plan', 'Planner');
  // (a pick is also the default new chats start with: this one goes back to asking)
  await permButton(page).click();
  await page.locator('.perm-menu .perm-item.default').click();
  await send(page, 'apply approval mode');
  await expect(transcript(page).getByText('fake-claude: apply approval mode', { exact: true })).toBeVisible();
  await expect(permButton(page)).toContainText('Ask for approval');

  await send(page, ask('Claude Code', 'ask', { id: reviewer, title: 'Reviewer' }, 'hold-1', 'Please run the migration'));
  // the tool's answer is the hold, and the sender's card says it waits
  await expect(
    transcript(page)
      .getByText(/\[cu: .*"delivery": ?"held"/)
      .first(),
  ).toBeVisible();
  const out = card(page, 'out', 'Reviewer');
  await expect(out.locator('.peer-badge.held')).toHaveText('Waiting for approval');
  await expect(out.locator('.peer-note')).toHaveText(PEER_REASONS.held_mode_mismatch);
  // the sender can only cancel it, never allow it
  await expect(out.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await expect(out.getByRole('button', { name: 'Cancel message' })).toBeVisible();
  expect(codexGot(harness, 'Please run the migration')).toBe(false);

  // the receiving chat's user allows it: it is delivered and its reply comes back
  await sidebar(page).locator('.thread-row', { hasText: 'Reviewer' }).click();
  const held = card(page, 'in', 'Planner');
  await expect(held).toContainText('Please run the migration');
  await expect(held.locator('.peer-badge.held')).toHaveText('Waiting for approval');
  await held.getByRole('button', { name: 'Allow' }).click();
  await expect(held.locator('.peer-badge.delivered')).toHaveText('Delivered');
  await expect.poll(() => codexGot(harness, 'Please run the migration')).toBe(true);
  await sidebar(page).locator('.thread-row', { hasText: 'Planner' }).click();
  await expect(card(page, 'out', 'Reviewer').first().locator('.peer-badge.done')).toHaveText('Replied');

  // another one is declined: it ends on both cards and never reaches Codex
  await send(page, ask('Claude Code', 'ask', { id: reviewer, title: 'Reviewer' }, 'hold-2', 'Please drop the old table'));
  const second = card(page, 'out', 'Reviewer').filter({ hasText: 'Please drop the old table' });
  await expect(second.locator('.peer-badge.held')).toHaveText('Waiting for approval');
  await sidebar(page).locator('.thread-row', { hasText: 'Reviewer' }).click();
  const incoming = card(page, 'in', 'Planner').filter({ hasText: 'Please drop the old table' });
  await incoming.getByRole('button', { name: 'Decline' }).click();
  await expect(incoming.locator('.peer-badge.declined')).toHaveText('Declined');
  await expect(incoming.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await sidebar(page).locator('.thread-row', { hasText: 'Planner' }).click();
  await expect(second.locator('.peer-badge.declined')).toHaveText('Declined');
  expect(codexGot(harness, 'Please drop the old table')).toBe(false);
  expect(
    journal(harness)
      .filter((m) => !m.replyTo)
      .map((m) => [m.targetChatId, m.delivery, m.allowedByUser ?? false]),
  ).toEqual([
    [reviewer, 'delivered', true],
    [reviewer, 'declined', false],
  ]);
});
