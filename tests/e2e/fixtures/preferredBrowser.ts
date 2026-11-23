// Settings → Browser → Preferred browser (Claude Desktop's one-row choice): its select, picking an option, and what it shows.
import type { Page } from '@playwright/test';
import { chooseSetting, settingsSelect } from './settings';

export const BUILTIN = 'Built-in browser';
export const CHROME = 'Chrome';
/**
 * The remote switch that makes this build behave as one without MoPilot's own extension: Chrome is then reached
 * through Your Chrome over the Playwright Extension, the route the legacy journeys cover (control.cjs effectiveChannel).
 */
export const WITHOUT_OWN_EXTENSION = { 'shared.browser.chromeExtensionByDefault': false } as const;

/** The Preferred browser row's select button (its label is the current choice). */
export const preferredBrowser = (page: Page) => settingsSelect(page, 'Preferred browser');

/** Picks `label` from the Preferred browser select. */
export async function choosePreferredBrowser(page: Page, label: string): Promise<void> {
  await chooseSetting(page, 'Preferred browser', label);
}
