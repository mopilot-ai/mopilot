// Settings › MoMo › Sources (#2139 P2): one card per source through every state it has, on the fake computer-use helper's EventKit: off with what turning it on gives; Connect and Allow, then on with one line and the details (what it reads and keeps); Pause and Resume; a refusal that sends to System Settings and the wait for the switch; Files with no folder, then a folder, then Remove; and a narrow window. Each state is also saved as a screenshot in the test's output folder (sources-<n>-<state>.png) so the page can be looked at, not only asserted. Lost access (a connected source macOS refuses) needs the real helper's refusal, so it is the unit tests' and the VM's. The real prompt and pane are checked in a VM.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { captureExternal, openedExternal } from './fixtures/externalUrls';
import { goToMomoSettings, momoSetupDone, openMomo } from './fixtures/momo';

// the macOS helper's EventKit is what Calendar and Reminders connect through
test.skip(process.platform !== 'darwin', 'Calendar and Reminders connect through the macOS helper');

const card = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const status = (c: Locator) => c.locator('[data-status]');
const REMINDERS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders';

test.describe('Settings › MoMo › Sources', () => {
  test.use({ harnesses: 'claude', computerHelper: true, env: { MOPILOT_MOMO_DEV: '1' }, seed: { ...momoSetupDone } });

  test('every source is a card with one plain line and one primary action in each of its states', async ({ page, harness }, testInfo) => {
    let n = 0;
    const shot = (state: string) => page.screenshot({ path: testInfo.outputPath(`sources-${String(++n).padStart(2, '0')}-${state}.png`) });
    // a folder inside the home folder the app sees: the harness points HOME at its temp dir, and Files accepts only folders in it
    const appHome = harness.env.HOME;
    expect(appHome).toBeTruthy();
    const home = path.join(appHome!, `momo-sources-spec-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    try {
      await captureExternal(harness as any);
      await openMomo(page);
      await goToMomoSettings(page, 'Sources');
      const cal = card(page, 'Calendar');
      const rem = card(page, 'Reminders');
      const files = card(page, 'Files');

      // off: what turning each on gives, one Connect (Files: Add folder), nothing about levels
      await expect(status(cal)).toHaveText('Let MoMo see your upcoming events.');
      await expect(status(rem)).toHaveText('Let MoMo see what you still need to do.');
      await expect(status(files)).toHaveText('Choose the folders MoMo may read.');
      await expect(cal.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
      await expect(files.getByRole('button', { name: 'Add folder…' })).toBeVisible();
      await expect(page.getByText(/Read only|Read & ask to change|Blocked/)).toHaveCount(0);
      await shot('off');

      // Connect, Allow: on, one line, no primary action
      harness.helper!.eventkit.onPrompt = 'granted';
      await cal.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(status(cal)).toHaveText('MoMo can read your calendar.', { timeout: 20_000 });
      await expect(cal.locator('.hp-badge.ok')).toHaveText('Connected');
      await expect(cal.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
      await shot('on');

      // the details say what MoMo reads and keeps
      await cal.getByText('Details').click();
      await expect(cal.getByText(/Event titles, times, places and attendee names/)).toBeVisible();
      await expect(cal.getByText(/What it copied is deleted when you disconnect/)).toBeVisible();
      await shot('details');

      // Pause stops reading and says so; Resume brings it back
      await cal.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(status(cal)).toHaveText("Paused. MoMo won't read it.");
      await expect(cal.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
      await shot('paused');
      await cal.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(status(cal)).toHaveText('MoMo can read your calendar.');

      // a refusal at the prompt: the next step is the pane, the line says which switch, then it waits for it
      harness.helper!.eventkit.onPrompt = 'denied';
      await rem.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(status(rem)).toHaveText('Turn on MoPilot under Privacy & Security › Reminders.', { timeout: 20_000 });
      await expect(rem.getByText('Needs your OK')).toBeVisible();
      await shot('needs-your-ok');
      await rem.getByRole('button', { name: 'Open System Settings', exact: true }).click();
      await expect(status(rem)).toHaveText('Waiting for you to turn it on…', { timeout: 20_000 });
      await expect(rem.getByRole('button', { name: 'Open again', exact: true })).toBeVisible();
      expect(await openedExternal(harness as any)).toContain(REMINDERS_PANE);
      await shot('waiting');

      // Files: Add folder connects it; a cancelled dialog leaves it on with no folder, a picked one lists it with Remove
      await harness.app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      await files.getByRole('button', { name: 'Add folder…' }).click();
      await expect(status(files)).toHaveText('No folders yet. Add one for MoMo to read.', { timeout: 20_000 });
      await shot('files-empty');
      await harness.app.evaluate(({ dialog }, picked) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
      }, home);
      await files.getByRole('button', { name: 'Add folder…' }).click();
      // a refused folder shows its reason under the card: the failure then names it instead of only the status line
      const filesText = async () =>
        `${await status(files).textContent()} | ${(await files.getByRole('alert').allTextContents()).join(' | ')}`;
      await expect.poll(filesText, { timeout: 20_000 }).toContain('MoMo can read 1 folder.');
      await expect(status(files)).toHaveText('MoMo can read 1 folder.', { timeout: 20_000 });
      await expect(files.getByRole('list', { name: 'Folders MoMo may read' }).getByRole('listitem')).toHaveCount(1);
      await shot('files-folder');
      await files.getByRole('button', { name: /^Remove / }).click();
      await expect(status(files)).toHaveText('No folders yet. Add one for MoMo to read.');

      // a narrow window keeps every card whole
      await page.setViewportSize({ width: 520, height: 900 });
      await expect(cal).toBeVisible();
      await shot('narrow');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
