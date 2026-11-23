// A Claude Code chat moved to Read-only and back to Full access runs its next message in Full access (#4648): after a steered turn
// (the CLI folds the steer into its running loop and answers with one result), the Read-only pick starts a CLI with its whitelist,
// and the Full access pick starts one in bypassPermissions, with the button, the check mark and the write all following.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const queued = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: text });
const permButton = (page: Page) => page.getByRole('button', { name: 'Change permissions' });
const row = (page: Page, id: string) => page.locator(`.perm-menu .perm-item.${id}`);

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickPermission(page: Page, id: 'read-only' | 'full-access') {
  await permButton(page).click();
  await row(page, id).click();
}
/** The mode and process the fake Claude Code ran each of the chat's turns in, by the turn's text. */
const turnOf = (h: Harness, text: string) => {
  const t = h.claudeLog().find((e: any) => e.kind === 'turn' && e.text === text) as any;
  return { mode: t?.mode, pid: t?.pid };
};

test.use({ harnesses: 'both' });

test('Read-only and back to Full access after a folded steer: the next message runs in the mode picked, and the picker follows', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await pickPermission(page, 'full-access');

  // a running command, then a follow-up steered into it: the CLI answers both with one result and reports idle
  await send(page, 'FOLDSTEER RUNCMDSTREAM run the suite');
  await expect(stop(page)).toBeVisible();
  await send(page, 'also check the docs');
  await queued(page, 'also check the docs').getByRole('button', { name: 'Steer' }).click();
  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText(/fake-claude: FOLDSTEER RUNCMDSTREAM run the suite \[command: ran\]/)).toBeVisible();
  await expect(stop(page)).toHaveCount(0);

  // Read-only: the write is refused without a card
  await pickPermission(page, 'read-only');
  await send(page, 'EDITFILE blocked');
  await expect(transcript(page).getByText(/fake-claude: EDITFILE blocked \[edit: declined\]/)).toBeVisible();
  await expect(permButton(page)).toContainText('Read-only');

  // back to Full access: the pick waits for the next message, which runs in it
  await pickPermission(page, 'full-access');
  await permButton(page).click();
  await expect(page.locator('.perm-mode-note')).toHaveText('Full access applies to your next message.');
  await expect(row(page, 'read-only')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await send(page, 'EDITFILE allowed');
  await expect(transcript(page).getByText(/fake-claude: EDITFILE allowed \[edit: written\]/)).toBeVisible();
  await expect(permButton(page)).toContainText('Full access');
  await permButton(page).click();
  await expect(row(page, 'full-access')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.perm-mode-note')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // each message ran in the mode picked, on a CLI started for it: Read-only's has its whitelist, Full access's is a new one again
  const first = turnOf(harness, 'FOLDSTEER RUNCMDSTREAM run the suite');
  const blocked = turnOf(harness, 'EDITFILE blocked');
  const allowed = turnOf(harness, 'EDITFILE allowed');
  expect([first.mode, blocked.mode, allowed.mode]).toEqual(['bypassPermissions', 'dontAsk', 'bypassPermissions']);
  expect(new Set([first.pid, blocked.pid, allowed.pid]).size).toBe(3);
});
