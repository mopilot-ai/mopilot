// A new Claude Code chat is titled at send by its login's warm title CLI (#3413): the sidebar row and the title bar read
// the generated title while the chat's own CLI is still starting (it reads no input while ~/.fake-hold-start exists, as a
// real CLI loading MCP servers and hooks), and the title is saved in the session once that CLI runs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { claudeChatProcesses } from './fixtures/claudeChat';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');

test.use({
  harnesses: 'claude',
  seed: { files: ({ home }) => fs.writeFileSync(path.join(home, '.fake-hold-start'), '') },
});

test("the generated title shows while the chat's CLI still starts, then is saved in its session", async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('fix the login bug');
  await expect(composer(page)).toHaveText('fix the login bug');
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // the chat's CLI has answered nothing yet, and the chat is already named
  await expect(sidebar(page).getByText('Fake chat title', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.tb-title-text')).toHaveText('Fake chat title');
  console.log(`[title-at-send] send → generated title: ${Date.now() - sent} ms`);
  await expect(transcript(page).getByText('fake-claude: fix the login bug', { exact: true })).toHaveCount(0);

  fs.rmSync(path.join(harness.dir, 'home', '.fake-hold-start'));
  await expect(transcript(page).getByText('fake-claude: fix the login bug', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('Fake chat title', { exact: true })).toBeVisible();
  // saved where the CLI and other apps read it
  const [argv] = [...claudeChatProcesses(harness).values()];
  const sessionId = argv.find((a) => a.startsWith('--session-id='))!.slice('--session-id='.length);
  const projects = path.join(harness.dir, 'home', '.claude', 'projects');
  const file = () =>
    fs
      .readdirSync(projects)
      .map((d) => path.join(projects, d, `${sessionId}.jsonl`))
      .find((f) => fs.existsSync(f));
  await expect.poll(() => fs.readFileSync(file() ?? '/dev/null', 'utf8')).toContain('"customTitle":"Fake chat title"');
});
