// MoMo's drafts (A3, design/phone-on-orca/momo-drafts-contract.md), on fake Claude Code and fake Codex with MoMo's session under real confinement: momo_draft shows a draft as a card in the chat as an Email card (a copy icon, ×, Edit and Open in Mail, no control that sends); Edit changes the words on the card, Copy puts the body on the clipboard, and Open in Mail hands the (edited) words to the system as a mailto link, which the harness intercepts (no mail app and no browser is launched); a draft too long for a link has Open in Mail off; a bad address is refused and shows no card.
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { captureExternal } from './fixtures/externalUrls';
import { momoChatSession, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';

// needs a Mac: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

/** The names of a card's buttons: the copy icon and × are named by their label, the others by their text. */
const names = (card: Locator) => card.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? b.textContent));

const draft = (args: object) => `CUCALL momo_draft ${JSON.stringify(args)}`;
const REPLY = {
  to: ['sam@example.com', 'lee@example.com'],
  subject: 'Re: Friday lunch',
  body: 'Hi Sam,\n\nFriday works for me. Noon?\n\nThanks',
};

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      env: { MOPILOT_MOMO_DEV: '1' },
      seed: { ...momoSetupDone, ...momoSeed(harnesses).seed },
    });

    test('a draft is a card with Edit, Copy and Open in Mail; nothing sends; Open in Mail is intercepted, not launched', async ({
      page,
      harness,
    }) => {
      test.setTimeout(180_000);
      await sizeViewport(page, harness, 1280, 900);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      const opened = await captureExternal(harness);

      await send(draft(REPLY));
      const card = chat.locator('[data-kind="momoDraft"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('heading', { name: 'Email' })).toBeVisible();
      await expect(card).toContainText('sam@example.com, lee@example.com');
      await expect(card).toContainText('Re: Friday lunch');
      await expect(card).toContainText('Friday works for me. Noon?');
      expect(await names(card)).toEqual(['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
      // no control that sends, forwards or replies, on the card or in the draft's words
      await expect(card.getByRole('button', { name: /send|reply|forward/i })).toHaveCount(0);

      // Edit changes the words on the card
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      await card.getByRole('textbox', { name: 'Subject' }).fill('Re: Friday lunch at noon');
      await card.getByRole('textbox', { name: 'Draft text' }).fill('Noon works for me.');
      await card.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(card).toContainText('Re: Friday lunch at noon');
      await expect(card).toContainText('Noon works for me.');
      expect(await names(card)).toEqual(['Copy', 'Dismiss', 'Edit', 'Open in Mail']);

      // Copy puts the body on the clipboard
      await card.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect(card.getByRole('status')).toHaveText('Copied');
      expect(await harness.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Noon works for me.');

      // Open in Mail hands the edited words to the system as a mail link, which the harness records instead of opening
      await card.getByRole('button', { name: 'Open in Mail', exact: true }).click();
      await expect.poll(async () => (await opened()).length, { timeout: 10_000 }).toBe(1);
      const [url] = await opened();
      expect(url).toBe('mailto:sam@example.com,lee@example.com?subject=Re%3A%20Friday%20lunch%20at%20noon&body=Noon%20works%20for%20me.');
      expect(url.startsWith('mailto:')).toBe(true);
      await expect(card.getByRole('alert')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('momo-draft.png') });
    });

    test('a draft with no recipient says so; one too long for a link has Open in Mail off and Copy still works; a bad address shows no card', async ({
      page,
      harness,
    }) => {
      test.setTimeout(180_000);
      await sizeViewport(page, harness, 1280, 900);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      const opened = await captureExternal(harness);
      const cards = chat.locator('[data-kind="momoDraft"]');

      await send(draft({ subject: 'Notes', body: 'No one yet.' }));
      await expect(cards).toHaveCount(1, { timeout: 30_000 });
      await expect(cards.first()).toContainText('No recipient');

      const long = 'The review covered the plan and the open risks. '.repeat(60);
      await send(draft({ to: ['sam@example.com'], subject: 'Long notes', body: long }));
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      const second = cards.nth(1);
      await expect(second.getByRole('button', { name: 'Open in Mail', exact: true })).toBeDisabled();
      await expect(second).toContainText('Too long to open in Mail. Copy it instead.');
      await second.getByRole('button', { name: 'Copy', exact: true }).click();
      expect(await harness.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(long);
      expect(await opened()).toEqual([]);

      // a bad address is refused to MoMo with why, and no card is added
      await send(draft({ to: ['not an address'], body: 'x' }));
      await expect(chat.getByText(/is not an email address/)).toBeVisible({ timeout: 30_000 });
      // (the chat keeps earlier turns off the page as it grows, so what is checked is that no card holds the refused draft)
      await expect(cards.filter({ hasText: 'not an address' })).toHaveCount(0);
      expect(await cards.count()).toBeLessThanOrEqual(2);
      expect(await opened()).toEqual([]);
    });
  });
}
