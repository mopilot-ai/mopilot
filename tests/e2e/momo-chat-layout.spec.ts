// MoMo's chat keeps to the window (#2277), on fake harnesses only: after a finished turn the transcript's response
// room and the chat stop changing height, the transcript scrolls in its own view inside the window, and the composer
// stays on screen. It reads only the chat (ThreadView), not how MoMo's page around it is laid out. Before the fix the
// page scrolled, so the room under the turn was sized from a scroller as tall as its content and grew by about
// 2,000 px a second, pushing the composer out of reach.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply, momoSeed, openMomo } from './fixtures/momo';

/** Heights that would move if the layout fed back into itself. */
const heights = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector<HTMLElement>('.thread-view')!;
    const scroll = view.querySelector<HTMLElement>('.thread-scroll')!;
    const room = view.querySelector<HTMLElement>('.thread-response-space');
    return {
      room: room ? room.getBoundingClientRect().height : null,
      view: view.getBoundingClientRect().height,
      viewBottom: view.getBoundingClientRect().bottom,
      scroll: scroll.clientHeight,
      document: document.documentElement.scrollHeight,
      window: window.innerHeight,
    };
  });

for (const [harnesses, reply] of [
  ['claude', 'fake-claude'],
  ['codex', 'fake-codex'],
] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('after a finished turn the transcript stays inside the window and the composer stays on screen', async ({ page }) => {
      await openMomo(page);
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('hello MoMo');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText(momoReply(reply, 'hello MoMo'))).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });

      // the turn has ended: once its last lines are revealed and laid out (up to a few pixels), nothing changes for 3 s.
      // Before the fix nothing settled: the room grew ~2,000 px a second.
      const seen: Awaited<ReturnType<typeof heights>>[] = [];
      let still = 0;
      await expect
        .poll(
          async () => {
            const now = await heights(page);
            still = seen.length && JSON.stringify(now) === JSON.stringify(seen.at(-1)) ? still + 1 : 0;
            seen.push(now);
            return still >= 4;
          },
          { timeout: 10_000, intervals: [250], message: 'the transcript settles for a second after the turn' },
        )
        .toBe(true);
      const first = seen.at(-1)!;
      const samples = [first];
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(500);
        samples.push(await heights(page));
      }
      // every sample, so a failure shows how the room moved
      expect(samples.map((sample) => sample.room)).toEqual(samples.map(() => first.room));
      for (const sample of samples) expect(sample).toEqual(first);
      // the transcript scrolls in a view inside the window, and the room is never taller than the window
      expect(first.viewBottom).toBeLessThanOrEqual(first.window);
      expect(first.scroll).toBeLessThanOrEqual(first.window);
      expect(first.room!).toBeLessThanOrEqual(first.window);
      expect(first.document).toBeLessThanOrEqual(first.window);
      await expect(composer).toBeInViewport();
      // and the composer still takes the next message
      await composer.fill('again');
      await expect(composer).toHaveText('again');
    });
  });
}
