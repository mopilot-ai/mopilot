// CUJ goal-and-away on both harnesses: set a goal, leave the chat (the user is away), and come back through the
// notification. Codex: the goal's own round needs a Mac app nobody authorized, so it is refused, the goal pauses and
// one notification goes out; the chat is on screen, so its access card comes up as soon as the stopped turn ends.
// The user goes to a new chat (no card there); clicking the notification brings the chat back with the same card,
// the user authorizes, the bar says Paused, and Resume runs the goal to completion with one "Goal complete"
// notification. Claude Code: the goal runs on while the usage-limited login hands over to the second one, and
// completes in the bar.
import { standaloneNewChat } from './fixtures/sidebar';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { expectGoalRunning, goalCard, goalPill } from './fixtures/goal';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** Keep every OS notification the main process would show, so a test can read it and click it. */
async function captureNotifications(h: Harness) {
  await h.app.evaluate(({ Notification }) => {
    (globalThis as any).__shown = [];
    Notification.prototype.show = function (this: any) {
      (globalThis as any).__shown.push(this);
    };
  });
  const list = () =>
    h.app.evaluate(() => ((globalThis as any).__shown as any[]).map((n) => ({ title: n.title as string, body: n.body as string })));
  const click = (i: number) => h.app.evaluate((_, i) => (globalThis as any).__shown[i].emit('click'), i);
  return { list, click };
}

test.describe('Codex', () => {
  test.use({
    harnesses: 'codex',
    computerHelper: true,
    seed: { files: remoteFlags(COMPUTER_TOOLS), uiState: { prefs: { notifyOnComplete: 'always' } } },
  });

  test('goal-and-away on Codex: a refused computer call pauses the goal with one notification; back through it, authorize, Resume to complete', async ({
    page,
    harness,
  }) => {
    const notes = await captureNotifications(harness);
    await expect(home(page)).toBeVisible();
    // the first round is the user's; the second starts by itself and needs a Mac app nobody authorized
    await send(page, '/goal CONTINUE FINISH CUCALL computer_click {"x":1,"y":2}');
    await expect(
      transcript(page).getByText(/\[cu: error: Controlling Notes needs the user's OK, and nobody is here to give it/),
    ).toBeVisible();
    // The chat is on screen as it pauses, so the refused request comes up as its card once the turn ends
    // (the card takes the goal bar's place until it is answered).
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await expect.poll(() => harness.codexLog().some((e) => e.method === 'thread/goal/set' && e.params.status === 'paused')).toBe(true);
    await expect(page.locator('.row-goal')).toHaveCount(1);
    await expect
      .poll(async () => (await notes.list()).filter((n) => /needs your OK to control Notes\. Goal paused\./.test(n.title + n.body)).length)
      .toBe(1);

    // the user goes elsewhere without answering: a new chat is on screen with no card. Clicking the notification brings the chat back
    await standaloneNewChat(page).click();
    await expect(home(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await notes.click(0);
    await expect(transcript(page).getByText(/\[cu: error: Controlling Notes needs the user's OK/)).toBeVisible();
    // with the same card, not a second one
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await expect(card(page)).toHaveCount(1);
    await page.keyboard.press('2');
    await expect(card(page)).toHaveCount(0);
    await expect(goalPill(page)).toContainText('Paused');
    await expect(await goalCard(page)).toContainText('CUCALL');
    expect(harness.helper!.log.filter((m) => m.method === 'input.click')).toHaveLength(0);

    // Resume: the goal's own round now runs against the new grant and the goal completes
    await (await goalCard(page)).getByRole('button', { name: 'Resume' }).click();
    await expect(
      transcript(page).getByText(/fake-codex: CONTINUE FINISH CUCALL computer_click .*\[cu: Done: click in Notes/),
    ).toBeVisible();
    await expect(goalPill(page)).toHaveCount(0);
    await expect(page.locator('.row-goal')).toHaveCount(0);
    await expect.poll(async () => (await notes.list()).map((n) => n.body)).toContain('Goal complete');
    const done = (await notes.list()).filter((n) => n.body === 'Goal complete');
    expect(done).toHaveLength(1);
    // the paused goal was set paused once and active again by Resume, and the helper clicked only the one authorized time
    const sets = harness
      .codexLog()
      .filter((e) => e.method === 'thread/goal/set')
      .map((e) => e.params.status);
    expect(sets).toEqual(expect.arrayContaining(['active', 'paused']));
    expect(harness.helper!.log.filter((m) => m.method === 'input.click')).toHaveLength(1);
  });
});

function limitedDefaultAndSecond(d: Dirs) {
  fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '');
  const second = { id: 'second', email: 'second@example.test', subscriptionType: 'max', authMethod: 'claude.ai', loggedIn: true };
  fs.writeFileSync(
    path.join(d.userData, 'claude-accounts.json'),
    JSON.stringify({ active: 'default', autoSwitch: true, accounts: [second] }),
  );
}

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude', seed: { files: limitedDefaultAndSecond, uiState: { prefs: { notifyOnComplete: 'always' } } } });

  test('goal-and-away on Claude Code: the goal rides through the login hand-over, completes, and its notification opens the chat', async ({
    page,
    harness,
  }) => {
    const notes = await captureNotifications(harness);
    await expect(home(page)).toBeVisible();
    await send(page, '/goal finish the list');
    await expect(await goalCard(page)).toContainText('finish the list');
    // the first login is out of usage: the second takes over and the goal and plan mode carry over
    await expect(
      transcript(page).getByText(/^Max limit reached(?: on \S+)?\. Continued on second@example\.test · Goal and plan mode carried over$/),
    ).toBeVisible();
    // the user goes to another chat while it works
    await standaloneNewChat(page).click();
    await expect(home(page)).toBeVisible();
    // the goal's notification takes the user back to the chat: during the hand-over the goal is not reported
    // as stopped, and the one notification is "Goal complete"
    await expect.poll(async () => (await notes.list()).some((n) => n.title === 'Fake chat title')).toBe(true);
    expect(
      (await notes.list())
        .filter((n) => n.title === 'Fake chat title')
        .map((n) => n.body)
        .filter((b) => /^Goal/.test(b)),
    ).toEqual(['Goal complete']);
    const mine = (await notes.list()).findIndex((n) => n.title === 'Fake chat title');
    await notes.click(mine);
    await expect(await goalCard(page)).toContainText('finish the list');
    await expect(goalPill(page)).toContainText('Complete');
    await expect((await goalCard(page)).locator('.goal-budget')).toHaveCount(0);
    await expect(transcript(page).getByText('fake-claude: done with finish the list').first()).toBeVisible();
    await (await goalCard(page)).getByRole('button', { name: 'Clear' }).click();
    await expect(goalPill(page)).toHaveCount(0);
  });
});

// Paying with an API key puts Sage's round limit on goals (30 rounds): at the limit the goal pauses and the bar
// offers 10 more rounds, which restarts it with a limit of 10.
test.describe('Claude Code on an API key', () => {
  test.use({ harnesses: 'claude' });

  test('a goal paused at the round limit gets 10 more rounds from the bar', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await page.locator('.side-row', { hasText: 'Accounts & billing' }).click();
    // Use an API key under Claude Code's accounts opens the key form in place; saved, the key is what it pays with
    const actions = page.locator('.acct-add-row[data-harness="claude"]');
    await actions.getByRole('button', { name: 'Use an API key' }).click();
    const form = page.locator('.acct-key-form');
    await form.getByPlaceholder(/sk-ant/).fill('sk-ant-test-12345');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'Use an API key' })).toHaveCount(0);
    await page.locator('.side-row', { hasText: 'Back to app' }).click();

    await send(page, '/goal never done SLOW');
    await expect(await goalCard(page)).toContainText('Reached the limit (30 rounds)', { timeout: 40_000 });
    await expect((await goalCard(page)).getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await (await goalCard(page)).getByRole('button', { name: '10 more rounds' }).click();
    // the goal is set again (a new goal, so its card starts closed) and runs under the new limit: it stops again
    // after 10 rounds, not 30
    await expectGoalRunning(page);
    await expect(goalPill(page)).toContainText('Round limit reached', { timeout: 40_000 });
    await expect(await goalCard(page)).toContainText('Reached the limit (10 rounds)');
    const sent = harness
      .claudeLog()
      .filter((e) => e.kind === 'in' && e.msg.type === 'user')
      .map((e) => JSON.stringify((e as any).msg.message.content));
    expect(sent.filter((t) => t === JSON.stringify('/goal never done SLOW'))).toHaveLength(2);
    await (await goalCard(page)).getByRole('button', { name: 'Clear' }).click();
    await expect(goalPill(page)).toHaveCount(0);
  });
});
