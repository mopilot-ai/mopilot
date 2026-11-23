// The draft card's Send and the Tasks pane's channel title, in the real renderer on fake Claude Code for an invited account (MOPILOT_MOMO_DEV=1) with the shell, channels and the Tasks panel on, using the fake mail accounts the E2E runs register (electron/momo/connectors/fakeMail.cjs: mail is kept in memory, nothing is reached). (a) A channel's Tasks pane is titled "Tasks in #<channel>". (b) A draft with no send-capable connector connected has no From and no Send; once the fake accounts are signed in through the real loopback flow it has Edit and Send (the account asked with chips with two accounts), Open in Mail gone; pressing Send is the approval (no MoMo approval card appears) and the card ends read only with "Asked to send", "You chose Send" and a sent line, no buttons and no Undo. Every state is saved as a picture (draft-send-<n>-<state>.png) in the test's output folder. Needs a Mac: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';
import { sizeViewport } from './fixtures/window';
import { goToMomoSettings, goToMomoView, momoChatSession, openMomo } from './fixtures/momo';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const CHANNEL = 'Reading';
const HOME = 'Test mail (home)';
const WORK = 'Test mail (work)';
const REPLY = { to: ['sam@example.com'], subject: 'Re: Friday lunch', body: 'Hi Sam,\n\nFriday works for me. Noon?\n\nThanks' };

const shell = (page: Page) => page.locator('[data-momo-shell]');
const rail = (page: Page) => shell(page).getByRole('navigation', { name: 'MoMo' });

/** The names of a card's buttons: the copy icon and × by their label, the others by their text. */
const names = (card: Locator) => card.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? b.textContent));

/** The contrast ratio of a button's label against its fill, from the computed styles: a label drawn in the fill's own colour is 1. */
const contrast = (button: Locator) =>
  button.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const lum = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const a = lum(rgb(cs.color));
    const c = lum(rgb(cs.backgroundColor));
    return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
  });

/** Scrolls a card to the middle of the thread so the composer does not cover its buttons in a picture. */
const reveal = (card: Locator) => card.evaluate((el) => el.scrollIntoView({ block: 'center' }));

/** Makes a channel through the rail's New row and waits for its chat (as momo-shell-layout.spec.ts does). */
async function makeChannel(page: Page, name: string) {
  await rail(page).getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
}

test.describe('the draft card sends from a connected mail account', () => {
  test.use({
    harnesses: 'claude',
    env: { MOPILOT_MOMO_DEV: '1' },
    seed: {
      uiState: {
        prefs: {
          momo: {
            onboarding: { done: true, step: 0 },
            shell: true,
            channels: true,
            tasksPanel: true,
            routines: { proactivity: 'default', quietHours: null },
          },
        },
      },
    },
  });

  test('a channel’s Tasks pane is titled for it; a draft has no Send until a mail account is connected, then Send asks, is chosen and ends read only', async ({
    page,
    harness,
  }, testInfo) => {
    test.setTimeout(420_000);
    let n = 0;
    const shot = async (state: string) => {
      // no hover in the picture, and eased states have settled
      await page.mouse.move(2, 2);
      await page.waitForTimeout(400);
      const path = testInfo.outputPath(`draft-send-${String(++n).padStart(2, '0')}-${state}.png`);
      await page.screenshot({ path });
      await testInfo.attach(state, { path, contentType: 'image/png' });
    };
    // tall enough that the card and its buttons clear the composer in the pictures
    await sizeViewport(page, harness, 1280, 1100);
    const opened = await captureExternal(harness as any);
    await openMomo(page);

    // (a) the Tasks pane opened from a channel says which channel
    await makeChannel(page, CHANNEL);
    await shell(page).getByRole('button', { name: 'Tasks', exact: true }).click();
    const pane = shell(page).getByRole('region', { name: `Tasks in #${CHANNEL}`, exact: true });
    await expect(pane).toBeVisible();
    await expect(pane.getByRole('heading', { name: `Tasks in #${CHANNEL}`, level: 2 })).toBeVisible();
    await shot('tasks-in-channel');
    await shell(page).getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(pane).toHaveCount(0);

    // (b) a draft in Main with no mail account connected: the draft as before, no From and no Send
    await rail(page)
      .getByRole('button', { name: /^(Main|Everything)$/ })
      .first()
      .click();
    const { chat, send } = await momoChatSession(page);
    await send(`CUCALL momo_draft ${JSON.stringify(REPLY)}`);
    const card = chat.locator('[data-kind="momoDraft"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Re: Friday lunch');
    // The Email card: the title, a copy icon and ×, Edit and (where nothing can send) Open in Mail; no Send, no account, no From
    await expect(card.getByRole('group', { name: 'Email' }).getByRole('heading', { name: 'Email' })).toBeVisible();
    expect(await names(card)).toEqual(['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await expect(card.getByText(/\bfrom\b/i)).toHaveCount(0);
    await reveal(card);
    // the pill at the right of the card is Open in Mail (the only primary here), and its label is readable on its fill
    await expect(card.getByRole('button', { name: 'Open in Mail', exact: true })).toBeInViewport();
    expect(
      await contrast(card.getByRole('button', { name: 'Open in Mail', exact: true })),
      'Open in Mail has a visible label',
    ).toBeGreaterThan(4.5);
    await shot('no-send-connector');

    // the fake mail accounts sign in through the real loopback flow (as momo-connectors.spec.ts does)
    const connect = async (label: string) => {
      const acct: Locator = page.getByRole('region', { name: label, exact: true });
      await acct.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect.poll(async () => (await opened()).length, { timeout: 20_000 }).toBeGreaterThan(0);
      const url = new URL((await opened()).at(-1)!);
      expect(url.origin + url.pathname).toBe('https://mail.test/authorize');
      const done = await fetch(`${url.searchParams.get('redirect_uri')}?code=c1&state=${url.searchParams.get('state')}`);
      expect(done.status).toBe(200);
      await expect(acct.locator('.hp-badge.ok')).toHaveText('Connected', { timeout: 20_000 });
    };
    // Settings › MoMo › Sources once, both accounts there, then Back to app (the MoMo rail is not on screen in Settings)
    await goToMomoSettings(page, 'Sources');
    await connect(HOME);
    await connect(WORK);
    await page.getByRole('button', { name: /^Back to app/ }).click();

    // with send-capable connectors the card has Edit and Send, and Open in Mail is gone; two accounts and none the default, so MoMo asks which
    // account in a plain line with chips and Send waits for the answer
    await goToMomoView(page, 'Chat');
    const back = chat.locator('[data-kind="momoDraft"]').first();
    await expect(back).toBeVisible();
    const emailCard = back.getByRole('group', { name: 'Email' });
    const sendButton = back.getByRole('button', { name: 'Send', exact: true });
    await reveal(back);
    // MoMo asks in a plain line with one chip per account (the app's own question: a tap sends the model nothing)
    const chips = back.getByRole('group', { name: 'Send from' });
    await expect(chips).toBeVisible({ timeout: 20_000 });
    await expect(back.getByText('Which account should I send it from?')).toBeVisible();
    await expect(chips.getByRole('button')).toHaveText([HOME, WORK]);
    await expect(back.getByRole('combobox')).toHaveCount(0);
    expect(await names(emailCard)).toEqual(['Copy', 'Dismiss', 'Edit', 'Send']);
    await expect(sendButton).toBeDisabled();
    // a disabled primary still shows its label
    expect(await contrast(sendButton), 'the disabled Send has a visible label').toBeGreaterThan(4.5);
    await expect(emailCard.getByRole('group', { name: 'Send from' })).toHaveCount(0);
    await shot('choose-account-chips');
    // the pick answers it: the chips and the question go, the line above the card names the account, and Send is on
    await chips.getByRole('button', { name: HOME, exact: true }).click();
    await expect(chips).toHaveCount(0);
    await expect(back.getByText('Which account should I send it from?')).toHaveCount(0);
    await expect(back.getByText(`Draft email to sam@example.com with subject Re: Friday lunch, from ${HOME}.`)).toBeVisible();
    await expect(sendButton).toBeEnabled();
    expect(await contrast(sendButton), 'Send is light text on a near-black fill').toBeGreaterThan(4.5);
    await expect(sendButton).toBeInViewport();
    await shot('send-connector-connected');

    // the person's press on Send is the approval, bound to what the card showed: no MoMo approval card is raised at any point
    const sawCard = page
      .locator('[data-kind="momoAction"]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    await back.getByRole('button', { name: 'Send', exact: true }).click();
    const status = back.getByRole('list', { name: 'Send status' }).getByRole('listitem');
    // the middle steps are brief with a fake account: the card ends read only with all three lines, nothing left to press, no Undo
    await expect(status).toHaveText(['Asked to send', 'You chose Send', `Sent from ${HOME}`], { timeout: 30_000 });
    expect(await sawCard, 'no approval card appeared').toBe(false);
    // read only: the card keeps the copy icon only (no Edit, Send or ×), and the lines are below it, outside it
    expect(await names(emailCard)).toEqual(['Copy']);
    await expect(emailCard.getByRole('list')).toHaveCount(0);
    await expect(back.getByRole('combobox')).toHaveCount(0);
    await expect(back).not.toContainText(/undo/i);
    await expect(back).toContainText('Re: Friday lunch');
    await reveal(back);
    await shot('sent-read-only');
  });
});
