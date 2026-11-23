// A spec's window size: the real app window, or the page's viewport sized the way each platform keeps the layout honest.
import type { Page } from '@playwright/test';
import { expect, type Harness } from './app';

/**
 * The real app window's content at `width` x `height`, on every platform. A window may be larger than the display: the
 * Windows runner's display is 1024x768, and a 1440x900 window still opens there (win-e2e run 43615099898).
 */
export async function sizeRealWindow(page: Page, harness: Pick<Harness, 'app'>, width: number, height: number) {
  const win = await harness.app.browserWindow(page);
  await win.evaluate((w, [cw, ch]) => w.setContentSize(cw, ch), [width, height] as const);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}

/**
 * The page's viewport at `width` x `height`. Windows sizes the real window: an emulated viewport keeps the title bar's
 * caption inset (env(titlebar-area-*), styles/app/titlebar.css --wco-w) at the real window's width, so a viewport wider
 * than the window slides the tabs under the caption buttons (win-e2e runs 43608770138, 43610383130). Elsewhere it is
 * emulated, as before.
 */
export async function sizeViewport(page: Page, harness: Pick<Harness, 'app'>, width: number, height: number) {
  if (process.platform === 'win32') return sizeRealWindow(page, harness, width, height);
  await page.setViewportSize({ width, height });
}
