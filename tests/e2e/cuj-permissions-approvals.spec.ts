// CUJ permissions-approvals on both harnesses: pick a permission mode in the composer (Full access shows its
// banner), approve and deny a command, approve and deny a file edit (the denial note reaches the agent), and on
// Claude Code the Read-only mode refuses writes and Bash without asking.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.approval-card');
const permButton = (page: Page) => page.getByRole('button', { name: 'Change permissions' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}
async function pickPermission(page: Page, row: 'read-only' | 'default' | 'full-access') {
  await permButton(page).click();
  await page.locator(`.perm-menu .perm-item.${row}`).click();
}

/** What the app answered to the fake Codex's server requests, in order. */
const codexDecisions = (h: Harness) =>
  h
    .codexLog()
    .filter((e) => e.method === null && e.response?.result?.decision !== undefined)
    .map((e) => e.response!.result.decision);

test.use({ harnesses: 'both' });

test('permissions-approvals on Codex: Full access banner, approve and deny a command, approve and deny a file edit', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-codex: hello', { exact: true })).toBeVisible();
  // the mode menu: Full access warns (inside a chat) until dismissed, and going back to Ask for approval clears it
  await pickPermission(page, 'full-access');
  await send(page, 'apply full access');
  await expect(transcript(page).getByText('fake-codex: apply full access', { exact: true })).toBeVisible();
  await expect(permButton(page)).toContainText('Full access');
  await expect(page.locator('.fa-banner')).toContainText('Full access is on');
  await page.locator('.fa-banner').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.fa-banner')).toHaveCount(0);
  await pickPermission(page, 'default');
  await send(page, 'apply approval mode');
  await expect(transcript(page).getByText('fake-codex: apply approval mode', { exact: true })).toBeVisible();
  await expect(permButton(page)).toContainText('Ask for approval');

  // a command asks; Allow once runs it
  await send(page, 'APPROVECMD first');
  await expect(card(page)).toContainText('Allow Codex to run this command?');
  await expect(card(page).locator('.approval-cmd')).toHaveText('npm test');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-codex: APPROVECMD first \[command: ran\]/)).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // the next one is denied with Esc: the agent hears the refusal
  await send(page, 'APPROVECMD second');
  await expect(card(page)).toContainText('Allow Codex to run this command?');
  await page.keyboard.press('Escape');
  await expect(transcript(page).getByText(/fake-codex: APPROVECMD second \[command: declined\]/)).toBeVisible();

  // a file edit: allowed once, the file is written
  await send(page, 'EDITFILE one');
  await expect(card(page)).toContainText('Allow Codex to edit');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-codex: EDITFILE one \[edit: written\]/)).toBeVisible();

  // denied with a note: the note goes to Codex as the next message
  await send(page, 'EDITFILE two');
  await expect(card(page)).toContainText('Allow Codex to edit');
  await card(page).getByRole('textbox', { name: 'Denial note' }).fill('use another name');
  await card(page).getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page).getByText(/fake-codex: EDITFILE two \[edit: declined\]/)).toBeVisible();
  await expect(transcript(page).getByText('fake-codex: use another name', { exact: true })).toBeVisible();
  expect(codexDecisions(harness)).toEqual(['accept', 'decline', 'accept', 'decline']);
});

test('permissions-approvals on Claude Code: approve and deny a command and a file edit; Read-only refuses without asking', async ({
  page,
}) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'RUNCMD first');
  await expect(card(page)).toContainText('Allow Claude Code to run this command?');
  await expect(card(page).locator('.approval-cmd')).toHaveText('npm test');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-claude: RUNCMD first \[command: ran\]/)).toBeVisible();

  await send(page, 'RUNCMD second');
  await expect(card(page)).toContainText('Allow Claude Code to run this command?');
  await card(page).getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page).getByText(/fake-claude: RUNCMD second \[command: declined\]/)).toBeVisible();

  await send(page, 'EDITFILE one');
  await expect(card(page)).toContainText('Allow Claude Code to edit');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-claude: EDITFILE one \[edit: written\]/)).toBeVisible();

  await send(page, 'EDITFILE two');
  await expect(card(page)).toContainText('Allow Claude Code to edit');
  await card(page).getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page).getByText(/fake-claude: EDITFILE two \[edit: declined\]/)).toBeVisible();

  // Read-only is Claude's dontAsk: the call is refused and no card is shown
  await pickPermission(page, 'read-only');
  await send(page, 'RUNCMD third');
  await expect(permButton(page)).toContainText('Read-only');
  await expect(transcript(page).getByText(/fake-claude: RUNCMD third \[command: declined\]/)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});
