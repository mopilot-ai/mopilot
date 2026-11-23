// CUJ cross-session-messaging (docs/multi-harness/CROSS-SESSION-MESSAGING.md): the user asks one chat to message
// another ("ask @chat ..."; no wording is required, as with Claude Code's SendMessage), the agent calls send_message_to_chat, the recipient
// works on it through its own current harness and its final answer comes back as the reply. Mixed pairs: Codex asks
// Claude Code; Claude Code asks an ACP chat (the fake agent as Kimi Code), and a recipient that cannot take it (an
// archived chat) shows Blocked with its reason instead of a delivery; a chat that switched from Claude Code to Codex
// takes a request into its running turn (as Claude Code drains one at its next tool round) and answers it while every
// window is closed; a fleet
// of chats named only in plain words finds each other by name and asks both ways.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { archiveSidebarChat } from './fixtures/sidebar';
import { PEER_REASONS } from '../../shared/peerReasons.mjs';
import { ask, call, card, chat, codexLogin, home, journal, pick, prompted, saved, send, sidebar, transcript } from './fixtures/peerChats';

test.describe('both harnesses', () => {
  test.use({ harnesses: 'both', seed: codexLogin });

  test('a Codex chat asks a Claude Code chat and gets its reply; each side shows its card and links to the other', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const reviewer = await chat(page, harness, 'Claude Code', 'ready to review', 'Reviewer');
    await chat(page, harness, 'Codex', 'drafting the plan', 'Planner');

    await send(page, ask('Codex', 'ask', { id: reviewer, title: 'Reviewer' }, 'review-1', 'Please review the plan draft'));
    // main records the actual delivery state (the tool's answer). The planner's turn may not print it: the reviewer's
    // reply can steer into that turn before it ends (its next tool round, as Claude Code drains one), ending it there.
    const request = () => journal(harness).find((m) => m.targetChatId === reviewer && !m.replyTo);
    await expect.poll(() => request()?.delivery).toMatch(/^(queued|submitting|delivered)$/);
    const out = card(page, 'out', 'Reviewer');
    await expect(out).toContainText('Please review the plan draft');
    await expect(out.locator('.peer-badge.delivered')).toHaveText('Delivered');
    // the recipient worked on it through Claude Code, and its final answer came back as the reply
    await expect.poll(() => prompted(harness, 'Please review the plan draft')).toBe(true);
    await expect(out.locator('.peer-badge.done')).toHaveText('Replied');
    await expect(card(page, 'in', 'Reviewer')).toContainText('fake-claude:');

    // the card's link opens the recipient, which shows the request it received from the planner
    await out.locator('.peer-chat-link').click();
    await expect(sidebar(page).locator('.thread-row.selected')).toContainText('Reviewer');
    await expect(card(page, 'in', 'Planner')).toContainText('Please review the plan draft');
    // and the turn it started says who sent it, by name, as a linked session's message does; the name opens the sender
    const received = transcript(page).locator('.side-session-note-head', { hasText: 'Received message from Planner' });
    await expect(received).toBeVisible();
    await received.locator('.peer-chat-link').click();
    await expect(sidebar(page).locator('.thread-row.selected')).toContainText('Planner');
  });
});

test.describe('a fleet of chats, no mention needed (#3364)', () => {
  test.use({ harnesses: 'both', seed: codexLogin });

  test('the user names a chat in plain words: each side finds the other by name, asks it and gets the reply, both ways', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const reviewer = await chat(page, harness, 'Claude Code', 'ready to review', 'Reviewer');
    const planner = await chat(page, harness, 'Codex', 'drafting the plan', 'Planner');

    // Planner (Codex): no link, no @, a verb no list had ("协作"); the agent finds Reviewer by name and asks it
    await send(page, ['和 Reviewer 协作一下', call('Codex', 'list_chats', { query: 'Reviewer' })].join('\n'));
    await expect(
      transcript(page)
        .getByText(new RegExp(`"id": ?"${reviewer}"`))
        .first(),
    ).toBeVisible();
    await send(page, call('Codex', 'send_message_to_chat', { targetChatId: reviewer, requestId: 'fleet-1', body: 'Which screens first?' }));
    const out = card(page, 'out', 'Reviewer');
    await expect(out.locator('.peer-badge.done')).toHaveText('Replied');
    await expect(card(page, 'in', 'Reviewer')).toContainText('fake-claude:');

    // Reviewer (Claude Code) starts its own request back to Planner, again with no mention
    await sidebar(page).locator('.thread-row', { hasText: 'Reviewer' }).click();
    await expect(card(page, 'in', 'Planner')).toContainText('Which screens first?');
    await send(
      page,
      [
        'follow up with Planner',
        call('Claude Code', 'send_message_to_chat', { targetChatId: planner, requestId: 'fleet-2', body: 'Home, then chat?' }),
      ].join('\n'),
    );
    const back = card(page, 'out', 'Planner');
    await expect(back.locator('.peer-badge.done')).toHaveText('Replied');
    await expect(card(page, 'in', 'Planner').last()).toContainText('fake-codex:');
    expect(
      journal(harness)
        .filter((m) => !m.replyTo)
        .map((m) => [m.sourceChatId, m.targetChatId, m.delivery]),
    ).toEqual([
      [planner, reviewer, 'delivered'],
      [reviewer, planner, 'delivered'],
    ]);
  });
});

test.describe('Claude Code and an ACP chat', () => {
  test.use({ harnesses: 'both', acp: { kimi: {} }, seed: codexLogin });

  test('a Claude Code chat asks an ACP chat and gets its reply; an archived recipient is Blocked, never delivered', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const old = await chat(page, harness, 'Codex', 'an old thread', 'Old thread');
    const oldRow = sidebar(page).locator('.thread-row', { hasText: 'Old thread' });
    await oldRow.hover();
    await archiveSidebarChat(page, oldRow);
    await expect(oldRow).toHaveCount(0);
    await chat(page, harness, 'Claude Code', 'deciding', 'Lead');
    const notes = await chat(page, harness, 'Kimi Code', 'keep the notes', 'Notes');
    await sidebar(page).locator('.thread-row', { hasText: 'Lead' }).click();
    // the composer is the Lead chat's before anything is typed (a chat switch remounts it)
    await expect(transcript(page).getByText('fake-claude: deciding', { exact: true })).toBeVisible();

    await send(page, ask('Claude Code', 'tell', { id: notes, title: 'Notes' }, 'log-1', 'Log the decision to ship Friday'));
    const out = card(page, 'out', 'Notes');
    await expect(out).toContainText('Log the decision to ship Friday');
    await expect(out.locator('.peer-badge.done')).toHaveText('Replied');
    await expect(card(page, 'in', 'Notes')).toContainText('fake-acp:');
    const acpPrompts = () =>
      harness
        .acpLog('kimi')
        .filter((l) => l.kind === 'in' && l.msg?.method === 'session/prompt')
        .map((l) => JSON.stringify(l.msg.params.prompt));
    expect(acpPrompts().some((p) => p.includes('Log the decision to ship Friday'))).toBe(true);

    // a recipient that can't take it: the request is kept as Blocked with the reason, and nothing reaches its harness
    await send(page, ask('Claude Code', 'tell', { id: old, title: 'Old thread' }, 'old-1', 'The plan changed to Monday'));
    // (found by its text: the window lists no archived chats, so the card names this one by the title kept with the message)
    const blocked = card(page, 'out', 'The plan changed to Monday');
    await expect(blocked.locator('.peer-badge.blocked')).toHaveText('Blocked');
    await expect(blocked.locator('.peer-note')).toHaveText(PEER_REASONS.chat_archived);
    await expect(blocked.locator('.peer-badge.done')).toHaveCount(0);
    await expect(
      transcript(page)
        .getByText(/\[cu: .*"delivery": ?"blocked"/)
        .first(),
    ).toBeVisible();
    expect(
      harness.codexLog().some((l) => l.method === 'turn/start' && JSON.stringify(l.params).includes('The plan changed to Monday')),
    ).toBe(false);
    expect(journal(harness).find((m) => m.targetChatId === old)).toMatchObject({ delivery: 'blocked', errorCode: 'chat_archived' });
  });
});

test.describe('a recipient that switched harness, with no window open', () => {
  test.use({ harnesses: 'both', seed: codexLogin });

  test('a request to a switched chat’s running turn steers into it through Codex and is answered while every window is closed', async ({
    page,
    harness,
  }) => {
    test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
    await expect(home(page)).toBeVisible();
    // the recipient began on Claude Code and continues on Codex, where a turn is running
    const switched = await chat(page, harness, 'Claude Code', 'started on claude', 'Switched');
    await pick(page, 'Codex');
    // the sheet shows only when something in the chat is at risk; otherwise the pick switches at once
    await expect(page.getByText('Next message continues on').or(page.locator('.switch-sheet'))).toBeVisible();
    if (await page.locator('.switch-sheet').isVisible()) await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await send(page, 'keep going SLOW');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(() => saved(harness).find((c) => c.id === switched)?.kinds).toEqual(['claude', 'codex']);

    const sender = await chat(page, harness, 'Codex', 'checking numbers', 'Sender');
    await send(page, ask('Codex', 'ask', { id: switched, title: 'Switched' }, 'numbers-1', 'Please check the quarterly numbers'));
    // the running turn takes it at once (turn/steer), never queued behind it for a Steer click
    const out = card(page, 'out', 'Switched');
    await expect(out.locator('.peer-badge.delivered')).toHaveText('Delivered');
    await expect(out.locator('.peer-badge.queued')).toHaveCount(0);

    // every window closed: the turn finishes and its answer comes back as the reply with nobody watching
    await page.close();
    await expect.poll(() => harness.app.windows().length).toBe(0);
    // the sender's own turn holds the switched chat's conversation (the reference), "SLOW" included: it runs until
    // released too, so each running turn is let go in turn until the reply is in
    const release = path.join(harness.dir, 'fake-codex.jsonl.release');
    const message = () => journal(harness).find((m) => m.sourceChatId === sender && m.targetChatId === switched);
    await expect
      .poll(
        () => {
          if (!fs.existsSync(release)) fs.writeFileSync(release, '');
          return message()?.reply;
        },
        { timeout: 30_000 },
      )
      .toBe('received');
    expect(message()?.delivery).toBe('delivered');
    // through the chat's current harness (Codex), never the one it began on
    expect(
      harness.codexLog().some((l) => l.method === 'turn/steer' && JSON.stringify(l.params).includes('Please check the quarterly numbers')),
    ).toBe(true);
    expect(prompted(harness, 'Please check the quarterly numbers')).toBe(false);
    expect(await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);

    // the next window shows the sender's card answered
    await harness.app.evaluate(({ app }) => app.emit('activate'));
    const page2 = harness.app.windows()[0] ?? (await harness.app.waitForEvent('window'));
    await sidebar(page2).locator('.thread-row', { hasText: 'Sender' }).click();
    const answered = card(page2, 'out', 'Switched');
    await expect(answered.locator('.peer-badge.done')).toHaveText('Replied');
    await expect(card(page2, 'in', 'Switched')).toContainText('fake-codex:');
  });
});
