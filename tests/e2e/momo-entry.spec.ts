// MoMo's entry (#2139), on fake harnesses only: an invited account (an unpackaged build's dev invite, MOPILOT_MOMO_DEV=1,
// electron/momo/access.cjs) gets the sidebar's MoMo row and ⌘., a first run (Meet, Notifications, Setting up; #2607), then MoMo's page, with Chat and Memory
// (then Settings) in the sidebar column's own MoMo navigation; its main chat is made in MoMo's own folder in the app's data
// folder (<userData>/momo), answers a message on the fake harness (Claude Code and Codex alike) and shows in no list of chats. An account
// that wasn't invited sees no row and no page for ⌘., and nothing of MoMo is kept on disk.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import {
  goToMomoView,
  meetHeading,
  momoChat,
  momoNav,
  momoReply,
  momoRow,
  momoSeed,
  notificationsHeading,
  openMomo,
} from './fixtures/momo';

const sidebar = (page: Page) => page.getByRole('complementary');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const modDot = process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period';

/** The invited journey on one harness family: MoMo's main chat runs on whichever of them can (Claude Code first). */
function invited(harnesses: 'claude' | 'codex', reply: string) {
  test.describe(`invited, on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('the MoMo row opens setup, then MoMo’s page and its views; a message to MoMo is answered; MoMo’s chat is in no list', async ({
      page,
      harness,
    }) => {
      await expect(composer(page)).toBeVisible();
      const chatRows = sidebar(page).locator('.thread-row');
      const rowsBefore = await chatRows.count();
      await expect(momoRow(page)).toBeVisible();
      await expect(momoRow(page)).toContainText('MoMo');
      // the first run first
      await openMomo(page);
      const tabs = momoNav(page);
      for (const name of ['Chat', 'Memory', 'Settings']) await expect(tabs.getByRole('button', { name, exact: true })).toBeVisible();
      await expect(tabs.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');

      // the main chat is made on its first visit, in MoMo's folder under the app's data folder, never ~/.mopilot
      const userData = harness.env.MOPILOT_USER_DATA ?? path.join(harness.dir, 'userData');
      await expect.poll(() => fs.existsSync(path.join(userData, 'momo', 'state.json')), { timeout: 15_000 }).toBe(true);
      expect(fs.existsSync(path.join(harness.dir, 'home', '.mopilot', 'momo'))).toBe(false);

      await goToMomoView(page, 'Memory');
      // Feed and Topics are gone
      for (const name of ['Feed', 'Topics']) await expect(tabs.getByRole('button', { name, exact: true })).toHaveCount(0);

      // Settings opens Settings › MoMo, with its Brain, Routines and Sources tabs
      await tabs.getByRole('button', { name: 'Settings', exact: true }).click();
      for (const name of ['Brain', 'Routines', 'Sources'])
        await expect(
          page
            .getByRole('tab', { name, exact: true })
            .or(page.getByRole('button', { name, exact: true }))
            .first(),
        ).toBeVisible();
      await page.keyboard.press(modDot);
      await expect(momoNav(page)).toBeVisible();

      // a message in MoMo's Chat, answered by the fake harness
      await goToMomoView(page, 'Chat');
      const chat = momoChat(page);
      await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('hello MoMo');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(chat.getByText(momoReply(reply, 'hello MoMo'))).toBeVisible({ timeout: 20_000 });
      // back to the coding chats, where MoMo's chat is in no list; ⌘. comes back to MoMo from anywhere
      await page.getByRole('button', { name: 'Back to chats' }).click();
      await expect(chatRows).toHaveCount(rowsBefore);
      await page.getByRole('button', { name: 'New chat' }).first().click();
      await expect(composer(page)).toBeVisible();
      await expect(chatRows).toHaveCount(rowsBefore);
      await page.keyboard.press(modDot);
      await expect(momoNav(page)).toBeVisible();
    });
  });
}

/** MoMo's first run on one harness family: Meet, Notifications, then its Chat, where MoMo speaks first without a model and a suggestion is answered (by the fake harness). */
function started(harnesses: 'claude' | 'codex', reply: string) {
  test.describe(`first run, on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    // a real Codex sign-in leaves auth.json behind, which is how the pool lists the CLI's login as "default"
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, seed: { files: (d) => codexCliLogin(d) } });

    test('Meet (name, color, the brain only in a footnote, no Skip), Notifications (optional, no Calendar or Reminders), then the Chat: MoMo greets and a message of the user’s is answered', async ({
      page,
    }) => {
      await openMomo(page, { setup: 'stay' });
      await expect(meetHeading(page)).toHaveText('Meet MoMo');
      await expect(page.getByText('Your personal agent. It remembers what matters to you and helps with your day.')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('MoMo');
      await expect(page.getByRole('radio')).toHaveCount(5);
      // the brain is chosen for the user: a footnote, no picker, no Skip
      const harnessName = harnesses === 'claude' ? 'Claude Code' : 'Codex';
      await expect(page.getByText(new RegExp(`^Thinks with ${harnessName}( · .+)?\\. You can change this in Settings\\.$`))).toBeVisible({
        timeout: 15_000,
      });
      for (const gone of ['Skip setup', 'Change brain', 'Start'])
        await expect(page.getByRole('button', { name: gone, exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();

      // Notifications: one optional row; Calendar and Reminders are asked for in the chat, not here
      await expect(notificationsHeading(page)).toBeVisible();
      await expect(page.getByText('Notifications', { exact: true })).toBeVisible();
      for (const source of ['Calendar', 'Reminders']) await expect(page.getByText(source, { exact: true })).toHaveCount(0);
      // two optional rows, each with its own Turn on (A7 added the Morning brief, off until turned on: tests/e2e/momo-setup-brief.spec.ts)
      await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toHaveCount(2);
      await expect(page.getByText('Morning brief', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Not now', exact: true }).click();

      // the Chat: MoMo speaks first (a real message from the brain, the fake echoing it), and the user's own message is answered after it
      const chat = momoChat(page);
      await expect(chat).toBeVisible({ timeout: 20_000 });
      await expect(chat.getByText(new RegExp(`${reply}: `)).first()).toBeVisible({ timeout: 30_000 });
      await chat.getByRole('textbox', { name: 'Message', exact: true }).fill("Here's a bit about me");
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(chat.getByText(momoReply(reply, "Here's a bit about me"))).toBeVisible({ timeout: 30_000 });
      // setup is done: the page is MoMo's, and a later open goes straight to Chat
      await expect(momoNav(page)).toBeVisible();
      await page.getByRole('button', { name: 'Back to chats' }).click();
      await momoRow(page).click();
      await expect(chat).toBeVisible();
      await expect(meetHeading(page)).toHaveCount(0);
    });
  });
}

started('claude', 'fake-claude');
started('codex', 'fake-codex');

invited('claude', 'fake-claude');
invited('codex', 'fake-codex');

test.describe('not invited', () => {
  test.use({ harnesses: 'claude' });

  test('no MoMo row, ⌘. opens nothing, and nothing of MoMo on disk', async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    await expect(momoRow(page)).toHaveCount(0);
    await page.keyboard.press(modDot);
    await expect(momoNav(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    const userData = harness.env.MOPILOT_USER_DATA ?? path.join(harness.dir, 'userData');
    expect(fs.existsSync(path.join(userData, 'momo'))).toBe(false);
  });
});
