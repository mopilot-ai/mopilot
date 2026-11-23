// Entry points that follow the chat's current segment (WP7-12, A17): direct ratings on every harness (Codex uploads
// them, Claude Code counts them as usage data), Feedback, plugins and current-chat speech choices. Against the fake Codex and the fake Claude CLI.
import { standaloneNewChat } from './fixtures/sidebar';
import { openSettingsSection } from './fixtures/settings';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

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

test.use({ harnesses: 'both' });

test('direct ratings are enabled on Codex and Claude Code, sharing off too; Feedback remains on both', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello codex');
  await expect(transcript(page).getByText('fake-codex: hello codex', { exact: true })).toBeVisible();
  await transcript(page).getByText('fake-codex: hello codex', { exact: true }).hover();
  await expect(page.getByRole('button', { name: 'Good response', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Bad response', exact: true })).toBeEnabled();
  await expect(page.locator('.message-actions button')).toHaveCount(4);
  await composer(page).fill('/');
  await expect(page.locator('.slash-panel').getByText('Feedback', { exact: true })).toBeVisible();
  await composer(page).fill('');

  // a new chat on Claude Code
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'hello claude');
  await expect(transcript(page).getByText('fake-claude: hello claude', { exact: true })).toBeVisible();
  await transcript(page).getByText('fake-claude: hello claude', { exact: true }).hover();
  await expect(page.getByRole('button', { name: 'Fork chat from here' })).toBeVisible();
  // the fixture turns usage data sharing off; rating a reply is still the consent to send that rating
  const good = page.getByRole('button', { name: 'Good response', exact: true });
  await expect(good).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Bad response', exact: true })).toBeEnabled();
  await good.click();
  await expect(good).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Thanks for the feedback', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.message-actions button')).toHaveCount(4);
  await composer(page).fill('/');
  await expect(page.locator('.slash-panel').getByText('Feedback', { exact: true })).toBeVisible();
});

// sharing is on by default; the fixture turns it off (its uploads go to a closed local port, MOPILOT_API)
test('with usage data shared, a Claude Code reply can be rated and a thumbs down offers the bug report', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await openSettingsSection(page, 'privacy');
  const share = page.locator('.settings-row', { hasText: 'Share usage data' }).getByRole('switch');
  await share.click();
  await expect(share).toHaveAttribute('aria-checked', 'true');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'hello claude');
  const reply = transcript(page).getByText('fake-claude: hello claude', { exact: true });
  await expect(reply).toBeVisible();
  await reply.hover();
  const good = page.getByRole('button', { name: 'Good response', exact: true });
  const bad = page.getByRole('button', { name: 'Bad response', exact: true });
  await expect(good).toBeEnabled();
  await expect(bad).toBeEnabled();
  await good.click();
  await expect(good).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Thanks for the feedback', { exact: true }).first()).toBeVisible();
  await bad.click();
  await expect(bad).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Report a bug…' })).toBeVisible();
});

// a chat's thread/start: not the ephemeral ones Sage starts itself (the runtime probe at launch, the title helper)
const chatStart = (e: { method?: string | null; params?: any }) => e.method === 'thread/start' && !e.params?.ephemeral;

// the dictation service itself is chosen in Settings › Voice (tests/e2e/dictation-engine.spec.ts)
test('voice in Claude Code: dictation is offered, voice conversation is not, and the chat and typed draft stay', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'hello claude');
  await expect(transcript(page).getByText('fake-claude: hello claude', { exact: true })).toBeVisible();
  await composer(page).fill('Keep this draft');
  // dictation is macOS only: the button is hidden where no speech service exists (Linux CI)
  if (process.platform === 'darwin') await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
  // Claude Code has no native voice conversation: nothing opens one, and no dialog asks
  await expect(page.getByRole('button', { name: 'Voice conversation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(composer(page)).toHaveText('Keep this draft');
  await expect(transcript(page).getByText('fake-claude: hello claude', { exact: true })).toBeVisible();
  expect(harness.codexLog().some(chatStart)).toBe(false);
});
