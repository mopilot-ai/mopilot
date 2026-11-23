// MoMo's shell in the e2e specs, in one place: the sidebar's MoMo row, MoMo's own navigation (Chat, Memory,
// Settings) and the Chat region. Every MoMo spec opens MoMo and moves between its views through these, so a change to the
// shell (its navigation, headings or regions) is followed here and not in each spec.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { codexCliLogin } from './codexAccounts';

export type MomoView = 'Chat' | 'Tasks' | 'Memory';

/**
 * What a spec that opens MoMo on one harness family seeds (test.use): setup applies the brain it chose, and main refuses a Codex
 * account its identity domain does not list, which a real Codex sign-in does by leaving auth.json behind (fixtures/codexAccounts.ts).
 */
export const momoSeed = (harnesses: 'claude' | 'codex') =>
  harnesses === 'codex' ? { seed: { files: (d: Parameters<typeof codexCliLogin>[0]) => codexCliLogin(d) } } : {};

/**
 * What MoMo's answer to `text` reads on a fake harness: the fake echoes its input, which now opens with MoMo's own context block
 * (#2596) on a paragraph of its own, so the reply may start with the harness's prefix or with the end of that block.
 */
export const momoReply = (reply: string, text: string) =>
  new RegExp(`(?:${reply}: |</momo-context>\\s+)[\\s\\S]*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/**
 * What a spec seeds (test.use seed) when it is not about the first run: setup already done, so opening MoMo goes straight to its
 * Chat, MoMo does not greet (no turn is started) and the brain the spec arranged is not replaced by the one setup would pick.
 */
export const momoSetupDone = { uiState: { prefs: { momo: { onboarding: { done: true, step: 0 } } } } };

/** The sidebar's row that opens MoMo (shown once main says the account was invited). */
export const momoRow = (page: Page) => page.getByRole('complementary').locator('.momo-row');

/** MoMo's own navigation while its page is open: the sidebar column's, or with `momo.shell` on the shell's rail, which is the one column (#4926). */
export const momoNav = (page: Page) =>
  page.getByRole('complementary', { name: 'MoMo' }).or(page.locator('[data-momo-shell]').getByRole('navigation', { name: 'MoMo' }));

/** MoMo's Chat: a region of the page, not a tab panel. */
export const momoChat = (page: Page) => page.getByRole('region', { name: 'Chat', exact: true });

/** MoMo's first-run screens (#2607): Meet, then Notifications, then (briefly) Setting up, then its Chat. */
export const meetHeading = (page: Page) => page.getByRole('heading', { name: /^Meet /, level: 1 });
export const notificationsHeading = (page: Page) => page.getByRole('heading', { name: 'Stay in the loop', level: 1 });

/** Goes through MoMo's first run if it is showing (Continue on Meet, Not now on Notifications) and waits for its Chat; nothing to do once setup is done. */
export async function finishMomoSetup(page: Page) {
  const meet = meetHeading(page);
  // setup shows on the first visit and not after it is done; the navigation is there during setup too, so wait for what only
  // comes after it (the Chat region), never for the navigation: either Meet or Chat comes first
  await expect(meet.or(momoChat(page)).first()).toBeVisible({ timeout: 15_000 });
  if (!(await meet.isVisible())) return;
  // Continue waits for the brain to be chosen
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(next).toBeEnabled({ timeout: 15_000 });
  await next.click();
  await expect(notificationsHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(momoChat(page)).toBeVisible({ timeout: 20_000 });
}

/** Opens MoMo from the sidebar row and waits for its navigation; by default it also goes through the first run (setup: 'stay' leaves it on its first screen). */
export async function openMomo(page: Page, { setup = 'finish' }: { setup?: 'finish' | 'stay' } = {}) {
  await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible();
  await momoRow(page).click();
  if (setup === 'finish') await finishMomoSetup(page);
  await expect(momoNav(page)).toBeVisible();
}

/** Goes to one of MoMo's views through its navigation and waits for it: the Chat region, or the view's level-1 heading. */
export async function goToMomoView(page: Page, view: MomoView) {
  // the shell's rail has no Chat button: Main (or Everything) is the chat, and the page opens on it
  const rail = page.locator('[data-momo-shell]').getByRole('navigation', { name: 'MoMo' });
  if (view === 'Chat' && (await rail.count())) {
    await rail
      .getByRole('button', { name: /^(Main|Everything)$/ })
      .first()
      .click();
    await expect(momoChat(page)).toBeVisible();
    return;
  }
  // the shell has no Tasks button in its rail: Tasks is a pane, opened by the button at the top right of the page and named for the channel shown
  if (view === 'Tasks' && (await rail.count())) {
    const shell = page.locator('[data-momo-shell]');
    const pane = shell.getByRole('region', { name: /^Tasks( in #.+)?$/ });
    if (!(await pane.isVisible())) await shell.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(pane).toBeVisible();
    return;
  }
  const button = momoNav(page).getByRole('button', { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
  if (view === 'Chat') await expect(momoChat(page)).toBeVisible();
  else await expect(page.getByRole('heading', { name: view, level: 1, exact: true })).toBeVisible();
}

/** Settings › MoMo on one of its tabs (Brain, Routines, Sources), through MoMo's own navigation. */
export async function goToMomoSettings(page: Page, tab: 'Brain' | 'Routines' | 'Sources' = 'Brain') {
  await momoNav(page).getByRole('button', { name: 'Settings', exact: true }).click();
  // the segmented control's options are buttons (or tabs, depending on its markup)
  await page
    .getByRole('tab', { name: tab, exact: true })
    .or(page.getByRole('button', { name: tab, exact: true }))
    .first()
    .click();
}

/** A titled group of a Settings page (for example "Waiting for your approval" or "Routines" on Settings › MoMo › Routines). */
export const settingsGroup = (page: Page, title: string) =>
  page.locator('section.settings-group').filter({ has: page.getByRole('heading', { name: title, level: 2, exact: true }) });

/** MoMo's Chat with a way to send a message in it; MoMo must be open past setup. */
export async function momoChatSession(page: Page) {
  await goToMomoView(page, 'Chat');
  const chat = momoChat(page);
  const send = async (text: string) => {
    await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
  };
  return { chat, send };
}

/** The Muse-style shell has no page tabs: MoMo's views are the navigation's buttons. */
export const expectNoMomoTabs = (page: Page) => expect(page.getByRole('tablist')).toHaveCount(0);

/** Opens MoMo, goes through setup and returns its Chat with send. */
export async function openMomoChat(page: Page) {
  await openMomo(page);
  return momoChatSession(page);
}
