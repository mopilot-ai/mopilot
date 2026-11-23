// Screenshots of one surface for the visual review of a UI change: a spec runs once per theme (`THEMES`, seeded with `themeSeed`) and `shoot` names the file after the theme the app painted (<name>-dark.png, <name>-light.png).
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

export const THEMES = ['dark', 'light'] as const;

/** Seed for `test.use({ seed: { uiState } })`: the app opens in this theme. */
export const themeSeed = (theme: (typeof THEMES)[number]) => ({ prefs: { theme } });

export async function shoot(page: Page, name: string, options: Parameters<Page['screenshot']>[0] = {}) {
  // Playwright finishes finite animations and temporarily pauses infinite ones during capture. Waiting for
  // every document animation ourselves can hang forever on an offscreen or suspended element.
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.screenshot({ animations: 'disabled', ...options, path: test.info().outputPath(`${name}-${theme}.png`) });
}

/** Seed for a spec that calls `shootBoth`: the app follows the system theme, which `shootBoth` switches. */
export const SYSTEM_THEME = { prefs: { theme: 'system' } };

/** `shoot` in both themes of one run: the system theme is switched in the main process and the app repaints on its change event. */
export async function shootBoth(page: Page, app: ElectronApplication, name: string, options: Parameters<Page['screenshot']>[0] = {}) {
  for (const theme of THEMES) {
    await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // colors ease between themes: shoot once they have settled
    await page.waitForTimeout(600);
    await shoot(page, name, options);
  }
}
