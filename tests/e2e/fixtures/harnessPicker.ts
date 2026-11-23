// The composer's harness and model picker in the real app (src/components/harnessPicker/FirstTierPicker.tsx). Its
// "Select harness and model" row appears once a second harness is admitted, which main decides in its own time (a basic
// harness after its admission probe): on a loaded runner that can be after the window's first frame, so the picker is
// reopened until the row is there instead of clicking once and waiting on a menu that was built without it.
import { expect, type Page } from '@playwright/test';
import { chooseSetting, settingsEntry } from './settings';

/** Open the picker at its harness list, reopening it until the harnesses are listed. */
export async function openHarnessList(page: Page) {
  const picker = page.getByRole('button', { name: 'Select model' });
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  await expect(async () => {
    if (!(await toList.isVisible())) {
      // the picker is a toggle (class `active` while open): close a menu built before the harness was admitted
      if ((await picker.getAttribute('class'))?.split(/\s+/).includes('active')) await picker.click();
      await picker.click();
    }
    await expect(toList).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await toList.click();
}

/** The picker's effort panel: effort, speed and the account (the picker opens on it). */
export async function openEffortPanel(page: Page) {
  if (await page.locator('.effort-pop').isVisible()) return;
  await page.getByRole('button', { name: 'Select model' }).first().click();
  await expect(page.locator('.effort-pop')).toBeVisible();
}

/** Settings → All agents → New chats use: `label` ('Claude Code · Fake Sonnet'), then back to the app. A pick in a new chat is that chat's own. */
export async function chooseNewChatsDefault(page: Page, label: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'All agents' }).first().click();
  await chooseSetting(page, 'New chats use', label);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
}
