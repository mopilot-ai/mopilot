// MoMo's composer is one long pill as wide as its messages (ChatGPT's Dot draws it so), on fake Claude Code and fake Codex:
// at common window widths, with the sidebar open and closed, the composer's box and the transcript's column share their
// left and right edges. Before the fix the column was held to 640 px while the composer kept the chat's 736 px, so the two
// edges sat 48 px apart on each side.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply, momoSeed, openMomo } from './fixtures/momo';

/** The composer's box and the transcript column's box, in CSS pixels. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    };
    return { composer: box('.thread-composer-area .composer'), column: box('.thread-scroll .thread-column') };
  });

for (const [harnesses, reply] of [
  ['claude', 'fake-claude'],
  ['codex', 'fake-codex'],
] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('the composer spans the message column at every window width, with the sidebar open or closed', async ({ page }) => {
      test.setTimeout(120_000);
      await openMomo(page);
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('hello MoMo');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText(momoReply(reply, 'hello MoMo'))).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });

      const seen: Record<string, Awaited<ReturnType<typeof boxes>>> = {};
      for (const sidebar of ['open', 'closed'] as const) {
        if (sidebar === 'closed') await page.getByRole('button', { name: 'Toggle sidebar' }).click();
        for (const width of [900, 1280, 1680]) {
          await page.setViewportSize({ width, height: 860 });
          const key = `${width}/${sidebar}`;
          // the layout settles after the resize; the two boxes then share their edges (to a pixel)
          await expect
            .poll(
              async () => {
                const b = await boxes(page);
                seen[key] = b;
                return Math.abs(b.composer.left - b.column.left) <= 1 && Math.abs(b.composer.right - b.column.right) <= 1;
              },
              { message: `composer and column edges at ${key}` },
            )
            .toBe(true);
          await page.screenshot({ path: test.info().outputPath(`momo-composer-${harnesses}-${width}-${sidebar}.png`) });
        }
      }
      // the measurements, in the report, so a reviewer sees the widths without opening the screenshots
      await test.info().attach('boxes.json', { body: JSON.stringify(seen, null, 2), contentType: 'application/json' });
      // at the widest window both are the chat's full width (the token), not a narrower MoMo column
      expect(seen['1680/closed'].composer.width).toBe(736);
    });
  });
}
