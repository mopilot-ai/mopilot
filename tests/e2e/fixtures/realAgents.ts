// What the real-agent specs share (host-local-real, host-remote-real): the cheapest model of an agent's list at its lowest effort, and a transcript wait that prints what the chat showed when it fails.
import { expect, type Page } from '@playwright/test';

/** The chat's model: the first of the agent's list that matches `name`, at its lowest effort. */
export async function cheapModel(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Select model' }).click();
  // the picker opens on the effort of the chosen model: its model button leads to the list
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await page.getByRole('menuitemradio', { name }).first().click();
  const effort = page.getByRole('slider', { name: 'Effort' });
  if (await effort.isVisible().catch(() => false)) {
    await effort.focus();
    await page.keyboard.press('Home');
  }
  await page.keyboard.press('Escape');
}

/** Waits for `what` in the chat; a failure says what the chat held instead. */
export async function shownIn(page: Page, what: RegExp, message: string, timeout = 180_000) {
  const transcript = page.getByRole('main');
  try {
    await expect(transcript).toContainText(what, { timeout });
  } catch (error) {
    throw new Error(`${message}: ${(await transcript.innerText()).slice(0, 1200)} / ${String(error).slice(0, 120)}`);
  }
}
