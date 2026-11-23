// The app fixture with a scratch Chrome profile it writes its native host into, Chrome with MoPilot's extension started on it when a journey asks, and pairing them with the app's one Allow.
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test as base } from './app';
import { scratchChromeProfile } from './chromeProfile';
import { startChrome, type ExtensionChrome } from './extensionChrome';

export const test = base.extend<{
  /** The profile holds a Chrome's preferences without the extension, as one the user has used (else it is empty). */
  chromeUsedBefore: boolean;
  profile: ReturnType<typeof scratchChromeProfile>;
  launchChrome: () => Promise<ExtensionChrome>;
}>({
  chromeUsedBefore: [false, { option: true }],
  profile: async ({ chromeUsedBefore }, use) => {
    const p = scratchChromeProfile();
    p.create();
    if (chromeUsedBefore) {
      fs.mkdirSync(path.join(p.dir, 'Default'));
      fs.writeFileSync(path.join(p.dir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: {} } }));
    }
    await use(p);
    p.remove();
  },
  env: async ({ profile }, use) => use(profile.env),
  // Chrome starts once the app is up (its native host is written at startup) and closes before the app does
  launchChrome: async ({ profile, harness }, use, info) => {
    const lines: string[] = [];
    let chrome: ExtensionChrome | null = null;
    await use(async () => {
      await expect(harness.page.getByRole('main')).toBeVisible();
      chrome = await startChrome(profile.dir, (s) => lines.push(`${new Date().toISOString()} ${s}`));
      return chrome;
    });
    if (lines.length) await info.attach('chrome.log', { body: lines.join('\n') });
    await (chrome as ExtensionChrome | null)?.close();
  },
});
export { expect };

/**
 * How long the app's Allow dialog may take: the extension's first ask can miss the app (the native host is not up yet),
 * and it then asks again at its reconnect alarm (RECONNECT_ALARM, every 30 s), so one whole alarm period and the ask
 * itself must fit. A wait of the period alone ends just before the second ask lands.
 */
export const ALLOW_DIALOG_MS = 2 * 30_000 + 15_000;

/**
 * The extension's install page, then the app's one Allow (the extension asked through the native host by itself), and
 * the page saying it is connected: no code pasted and nothing pressed in Chrome. Returns the install page.
 */
export async function pairWithAllow(page: Page, chrome: ExtensionChrome): Promise<Page> {
  const welcome =
    chrome.context.pages().find((p) => p.url().includes('options.html')) ??
    (await chrome.context.waitForEvent('page', { predicate: (p) => p.url().includes('options.html'), timeout: 15_000 }));
  await welcome.waitForLoadState();
  await expect(welcome.locator('#welcome')).toBeVisible();
  await expect(welcome.locator('#step-connect')).toHaveText('Connect to MoPilot');
  const allow = page.getByTestId('chrome-allow-dialog');
  await expect(allow).toContainText('Allow Chrome to connect?', { timeout: ALLOW_DIALOG_MS });
  await allow.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(allow).toHaveCount(0, { timeout: 30_000 });
  // after Allow the extension connects at once, or, when that try misses the app, at its next reconnect alarm: one period and the try
  await expect(welcome.locator('#line')).toHaveText('Connected to MoPilot', { timeout: 2 * 30_000 });
  expect(await chrome.pairings()).toBe(0);
  return welcome;
}
