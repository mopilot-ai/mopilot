// Finds Settings sections through production labels and search, including setup pages hidden from the default sidebar,
// opens Settings → Connections from the sidebar, and opens and picks from a Settings row's select.
import { expect, type Locator, type Page } from '@playwright/test';
import { NAV } from '../../../src/lib/settingsNav';

/**
 * The way into Settings the sidebar offers: the header menu's item, or MoMo's own nav row while its page is open. Never a
 * chat's text, which can say "Settings" too (a reply streams it word by word, #2698).
 */
export function settingsEntry(page: Page): Locator {
  return page
    .getByRole('menuitem', { name: /^Settings\b/ })
    .or(page.locator('.side-row', { has: page.locator('.side-row-label', { hasText: /^Settings$/ }) }));
}

export function settingsLabel(section: string): string {
  const item = NAV.find((entry) => entry.id === section);
  if (!item) throw new Error(`Unknown Settings section: ${section}`);
  return item.label;
}

/** Search keeps missing-harness setup and the basic-harness index discoverable; restore the default sidebar afterward. */
export async function openSettingsSection(page: Page, section: string): Promise<void> {
  const label = settingsLabel(section);
  const nav = page.locator('.settings-nav');
  const search = nav.getByRole('textbox', { name: 'Search settings', exact: true });
  await search.fill(label);
  // the page found by its name, which shows no hint: a page found through its words also marks the query in its
  // hint ("Codex credits" under Accounts & billing), and that mark is the same text (#1869)
  await nav
    .locator('.side-row:not(.has-hint)')
    .filter({ has: page.getByText(label, { exact: true }) })
    .click();
  await search.fill('');
}

/** Settings → Connections (its Machines list) through the sidebar's Settings entry: the Run on menu's Add machine… opens the add sheet in place instead. */
export async function openConnections(page: Page): Promise<void> {
  // already in Settings (another section): only the section changes
  if (!(await page.locator('.settings-nav').isVisible())) {
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
  }
  await openSettingsSection(page, 'connections');
}

/** The select button of the Settings row titled `row` (its label is the current choice). */
export const settingsSelect = (page: Page, row: string): Locator => page.locator('.settings-row', { hasText: row }).locator('.select-btn');

/**
 * Opens the select of the Settings row titled `row` until its option `label` shows. A page fills in rows after it
 * opens (Settings → Browser's harness status above "Preferred browser", which a Codex chat's setup updates again), so
 * the row can move between Playwright's checks and its click, which then lands beside the button and opens nothing
 * (cuj-use-my-chrome on Codex, #1822). An open menu is left open (a click would close it) while its options load.
 */
export async function openSettingsSelect(page: Page, row: string, label: string): Promise<Locator> {
  const option = page.getByRole('menuitemcheckbox', { name: label, exact: true });
  await expect(async () => {
    if (!(await page.getByRole('menu').isVisible())) await settingsSelect(page, row).click({ timeout: 5_000 });
    await expect(option).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return option;
}

/**
 * Picks `label` from the select of the Settings row titled `row` until the row shows it: a row that moves or
 * re-renders between opening and picking costs a try, not the test.
 */
export async function chooseSetting(page: Page, row: string, label: string): Promise<void> {
  await expect(async () => {
    await (await openSettingsSelect(page, row, label)).click({ timeout: 2_000 });
    await expect(settingsSelect(page, row)).toHaveText(label, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
