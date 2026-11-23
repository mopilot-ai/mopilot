// MoMo is hidden from an account that is not invited (the closed alpha, electron/momo/access.cjs), on fake harnesses only: no sidebar row, no MoMo navigation at any moment of a load
// (watched from before the page's scripts run), ⌘. and the `momo` command do nothing, and an account that loses MoMo while it is open loses the row and the page at once.
// An account that is not invited is a run without MOPILOT_MOMO_DEV (an unpackaged build's stand-in for the invite); the loss is main's own `momo:access` broadcast, as an account switch sends it.
import type { Locator, Page } from '@playwright/test';
import { test, expect, sendAppCommand } from './fixtures/app';
import { momoNav, momoRow, momoSetupDone, openMomo } from './fixtures/momo';

const sidebar = (page: Page) => page.getByRole('complementary');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
/** A picture of the page, or of one part of it, written to the test's output folder (as tests/e2e/momo-sessions.spec.ts does) and attached to the report. */
async function picture(page: Page, name: string, part?: Locator) {
  const file = test.info().outputPath(`${name}.png`);
  await (part ?? page).screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}
const modDot = process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period';

/** Records every moment the page holds a MoMo row, MoMo's navigation or its shell, from before the page's own scripts run. */
const WATCH = `
  window.__momoSeen = 0;
  const seen = () => document.querySelector('.momo-row, [data-momo-shell], aside[aria-label="MoMo"], nav[aria-label="MoMo"]') !== null;
  const look = () => { if (seen()) window.__momoSeen++; };
  new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true });
  document.addEventListener('DOMContentLoaded', look);
`;
const seenCount = (page: Page) => page.evaluate(() => (window as unknown as { __momoSeen: number }).__momoSeen);

/** Main's broadcast of the gate to the app window (electron/app/identity.cjs broadcastAll('momo:access', allowed)). */
const broadcastAccess = (h: Parameters<typeof sendAppCommand>[0], allowed: boolean) =>
  h.app.evaluate(({ BrowserWindow }, value) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('momo:access', value);
  }, allowed);

test.describe('not invited', () => {
  test.use({ harnesses: 'claude' });

  test('no MoMo row or navigation at any moment of a load, ⌘. and the momo command do nothing', async ({ page, harness }) => {
    await page.addInitScript(WATCH);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    // exact counts first
    await expect(momoRow(page)).toHaveCount(0);
    await expect(momoNav(page)).toHaveCount(0);
    await expect(sidebar(page).getByText(/MoMo/)).toHaveCount(0);
    await picture(page, 'sidebar-not-invited', sidebar(page).first());

    // ⌘. and the command main sends for a MoMo notice or Ask MoMo's Open: nothing opens, the chat stays
    await page.keyboard.press(modDot);
    await sendAppCommand(harness, 'momo', { kind: 'chat', chatId: 'mc1' });
    await sendAppCommand(harness, 'momo');
    await expect(momoNav(page)).toHaveCount(0);
    await expect(momoRow(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(0);
    await picture(page, 'route-attempt-not-invited');

    // the whole load and everything after it held no MoMo element, not even for a frame
    expect(await seenCount(page)).toBe(0);
  });
});

test.describe('an account that loses MoMo while the app is open', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: momoSetupDone });

  test('the row, the page and its navigation go at once, and ⌘. and the command then do nothing', async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    await expect(momoRow(page)).toHaveCount(1);
    await openMomo(page);
    await expect(momoNav(page)).toHaveCount(1);
    await picture(page, 'momo-open-while-invited');

    await broadcastAccess(harness, false);
    await expect(momoNav(page)).toHaveCount(0);
    await expect(momoRow(page)).toHaveCount(0);
    await expect(sidebar(page).getByText(/MoMo/)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await picture(page, 'sidebar-after-loss', sidebar(page).first());

    await page.keyboard.press(modDot);
    await sendAppCommand(harness, 'momo', { kind: 'chat', chatId: 'mc1' });
    await expect(momoNav(page)).toHaveCount(0);
    await expect(momoRow(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await picture(page, 'route-attempt-after-loss');
  });
});
