// MoMo's Chat draws a reply as a grey bubble on the left and what the user sent as an accent-tint pill on the right (the
// approved Dot-style page, designs/momo-page-dot), on fake Claude Code and fake Codex, in the app's light and dark themes: after one turn the reply bubble has a
// background and a radius, sits on the column's left edge and is no wider than the column; the user's pill is tinted, not
// the reply's grey, and sits on the right edge. A screenshot per theme is saved for review.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply, momoSeed, openMomo } from './fixtures/momo';

const look = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    };
    const style = (el: Element) => getComputedStyle(el);
    const reply = document.querySelector('.thread-scroll .assistant-message')!;
    const user = document.querySelector('.thread-scroll .user-bubble')!;
    const column = document.querySelector('.thread-scroll .thread-column')!;
    return {
      column: box(column),
      reply: { ...box(reply), bg: style(reply).backgroundColor, radius: style(reply).borderTopLeftRadius },
      user: { ...box(user), bg: style(user).backgroundColor },
    };
  });

for (const theme of ['light', 'dark'] as const) {
  for (const [harnesses, fake] of [
    ['claude', 'fake-claude'],
    ['codex', 'fake-codex'],
  ] as const) {
    test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}, ${theme}`, () => {
      const seed = momoSeed(harnesses).seed;
      test.use({
        harnesses,
        env: { MOPILOT_MOMO_DEV: '1' },
        // the theme is the app's own setting (data-theme), not the browser's scheme
        seed: { ...seed, uiState: { prefs: { theme } } },
      });

      test('replies are bubbles on the left and the user’s message is a tinted pill on the right', async ({ page }) => {
        test.setTimeout(120_000);
        await openMomo(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello bubbles');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.getByText(momoReply(fake, 'hello bubbles'))).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });

        const l = await look(page);
        expect(l.reply.bg, 'the reply has a bubble background').not.toBe('rgba(0, 0, 0, 0)');
        expect(parseFloat(l.reply.radius), 'the reply bubble is rounded').toBeGreaterThanOrEqual(16);
        expect(l.reply.left - l.column.left).toBeLessThanOrEqual(1);
        expect(l.reply.width).toBeLessThanOrEqual(l.column.width);
        expect(l.user.right - l.column.right).toBeGreaterThanOrEqual(-1);
        expect(l.user.bg, 'the user’s pill is tinted, not the reply’s grey').not.toBe(l.reply.bg);
        await page.screenshot({ path: test.info().outputPath(`momo-bubbles-${harnesses}-${theme}.png`) });
      });
    });
  }
}
