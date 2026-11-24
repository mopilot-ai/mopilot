// Claude's own command catalog and the events around a turn (WP5-15, WP5-16): the / menu lists
// supportedCommands with aliases and skills, without terminal-only ones, and follows
// commands_changed; typed native commands go out as typed; MCP elicitations, multiSelect questions
// and denial notes reach the CLI; native hook feedback stays visible. Runs against fake-claude.mjs.
// e2e-covers: src/components/composer/ComposerInput.tsx
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeAllUserTexts, claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';
import { HOOK_FAILURE } from './fixtures/fake-turn-details.mjs';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const slash = (page: Page) => page.locator('.slash-panel');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const logged = (h: Harness, kind: string) => h.claudeLog().filter((e: any) => e.kind === kind) as any[];
// the chat's own messages: the app's background /usage probe must not stand in for a typed /usage
const userTexts = (h: Harness) => claudeChatMessages(h).map(claudeTextOf);

test.use({ harnesses: 'claude' });

test("the / menu is Claude's catalog; typed native commands pass through; commands_changed replaces it", async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/');
  await expect(slash(page).getByText('/code-review (/review)')).toBeVisible();
  await expect(slash(page).getByText('/fake-skill')).toBeVisible();
  // terminal-only commands aren't offered
  await expect(slash(page).getByText('/doctor')).toHaveCount(0);
  await composer(page).fill('');

  // /review is Claude's alias for /code-review, not Codex's review
  await send(page, '/review low');
  await expect(transcript(page).locator('.review-result')).toContainText('review low');
  await expect(page.getByText(/isn.t available for Claude Code chats/)).toHaveCount(0);
  expect(userTexts(harness)).toContain('/review low');

  await send(page, 'learn CMDCHANGE');
  await expect(transcript(page).getByText('fake-claude: learn CMDCHANGE', { exact: true })).toBeVisible();
  await composer(page).fill('/found');
  await expect(slash(page).getByText('/found-skill')).toBeVisible();
});

test('clicking a Claude command leaves it ready to edit and shows only its own argument hint', async ({ page, harness }) => {
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  const input = composer(page);
  await input.fill('/code-r');
  await slash(page).getByText('/code-review (/review)', { exact: true }).click();
  await expect(input).toBeFocused();
  await expect(slash(page)).toHaveCount(0);
  await expect(input).toHaveText('/code-review ', { useInnerText: false });
  await expect(input).toHaveAttribute('data-command-hint', '[low|medium|high]');
  expect(await input.evaluate((node) => getComputedStyle(node, '::after').content)).toBe('"[low|medium|high]"');
  expect(
    await page.evaluate(() => Array.from(CSS.highlights.get('composer-slash-command')?.values() ?? [], (range) => range.toString())),
  ).toContain('/code-review');
  expect(userTexts(harness)).toEqual(['warm up']);

  await page.keyboard.type('low');
  await expect(input).toHaveText('/code-review low');
  await expect(input).not.toHaveAttribute('data-command-hint');
  await page.keyboard.press('Enter');
  await expect(transcript(page).locator('.review-result')).toContainText('review low');
  expect(userTexts(harness)).toContain('/code-review low');

  await input.fill('/us');
  await slash(page).getByText('/usage', { exact: true }).click();
  await expect(input).toHaveText('/usage ');
  await expect(input).not.toHaveAttribute('data-command-hint');
  await page.keyboard.press('Enter');
  await expect(transcript(page).getByText(/Current session: 12% used/)).toBeVisible();
});

test('elicitations, multiSelect questions and denial notes reach Claude; native hook feedback stays visible', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'ELICIT please');
  await expect(page.getByText('fake-mcp needs input')).toBeVisible();
  await page.locator('.approval-card input.text-input').fill('acme');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(transcript(page).getByText(/\[elicitation: accept\]$/)).toBeVisible();
  expect(logged(harness, 'elicitation')[0].response).toEqual({ action: 'accept', content: { workspace: 'acme' } });

  await send(page, 'ASKMULTI now');
  await page.getByRole('button', { name: 'a.ts' }).click();
  await page.getByRole('button', { name: 'c.ts' }).click();
  await page
    .locator('.question-card')
    .getByRole('button', { name: /^Submit/ })
    .click();
  await expect(transcript(page).getByText(/\[answers: \{"Which files\?":"a\.ts, c\.ts"\}\]$/)).toBeVisible();

  await send(page, 'DENYME and HOOKFAIL');
  await page.getByRole('textbox', { name: 'Denial note' }).fill('use the local mirror');
  await page.getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page).getByText(/\[deny: The user declined this action: use the local mirror\]$/)).toBeVisible();
  const completed = transcript(page)
    .locator('.turn')
    .filter({ has: page.getByText('DENYME and HOOKFAIL', { exact: true }) });
  await completed.waitFor({ state: 'visible' });
  // A permission request does not imply recorded tool work; response actions signal completion either way.
  await expect(completed.locator('.message-actions')).toHaveCount(1);
  await expect(completed.locator('.worked-for.open')).toHaveCount(0);
  await expect(completed.getByText(HOOK_FAILURE, { exact: true })).toBeVisible();
});

test('!cmd in a Claude chat runs in the Sage pty and attaches the output, marked as outside the sandbox', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
  await send(page, '!echo bang-output-42');
  await expect.poll(() => userTexts(harness).join('\n')).toContain('bang-output-42');
  const sent = userTexts(harness).join('\n');
  expect(sent).toContain("outside Claude Code's sandbox");
  expect(sent).toContain('$ echo bang-output-42');
  // the command itself is never sent to Claude as typed
  expect(claudeAllUserTexts(harness).some((t) => t.trim() === '!echo bang-output-42')).toBe(false);
});

test("a typed /usage with Enter runs Claude's own command, not Sage's billing page (D-20)", async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/usage');
  await page.keyboard.press('Enter');
  await expect(transcript(page).getByText(/Current session: 12% used/)).toBeVisible();
  expect(userTexts(harness)).toContain('/usage');
});

test("/rename in a Claude chat renames it and says so when it can't (D-16)", async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/rename');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Usage: /rename <new name>')).toBeVisible();

  await send(page, '/rename Typed rename');
  await expect(page.getByRole('complementary').getByText('Typed rename', { exact: true })).toBeVisible();
});

test('/logout in a Claude chat opens Accounts & billing instead of removing an account (D-26)', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/logout');
  await page.keyboard.press('Enter');
  await expect(page.locator('.settings-title')).toHaveText('Accounts & billing');
  // and it opens on the account this chat runs on
  await expect(page.locator('[data-account="claude:default"]')).toHaveClass(/acct-focus/);
  await expect(page.locator('[data-account="claude:default"]')).toBeInViewport();
  // the command was Sage's: it never reached Claude
  expect(claudeAllUserTexts(harness)).not.toContain('/logout');
});
