import { archiveSidebarChat } from './fixtures/sidebar';
// CUJ worktree-environments on both harnesses: a project with an environment.toml, a chat started in worktree mode runs
// in a new worktree under ~/.mopilot/worktrees on a mopilot/ branch with the setup script run first, Settings →
// Worktrees lists it, and archiving the chat runs the cleanup script. (The Claude-only first version is in worktrees.spec.)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { writeTo } from './fixtures/scriptLine';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');

const ENV_TOML = `version = 1
name = "demo"

[setup]
script = "${writeTo('git rev-parse --abbrev-ref HEAD', 'setup-ran.txt')}"

[cleanup]
script = "${writeTo('echo cleaned', '../cleanup-ran.txt')}"
`;

async function pickRepo(h: Harness) {
  const repo = path.join(h.dir, 'home', 'work', 'demo');
  fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'environments', 'environment.toml'), ENV_TOML);
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init');
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, repo);
  return repo;
}

async function journey(page: Page, harness: Harness, fake: string, cwdOf: () => string[]) {
  await expect(composer(page)).toBeVisible();
  const repo = await pickRepo(harness);
  await sidebar(page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
  if (fake === 'fake-claude') {
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await page.keyboard.press('Escape');
  }
  await page.locator('label.ctx-check', { hasText: 'Worktree' }).click();
  await expect(page.locator('label.ctx-check input')).toBeChecked();
  await composer(page).fill('hello worktree');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(`${fake}: hello worktree`, { exact: true })).toBeVisible();

  // the chat runs in <home>/.mopilot/worktrees/<id>/demo on a mopilot/ branch, after the setup script
  const worktree = cwdOf().find((c) => c !== repo)!;
  const root = path.join(harness.dir, 'home', '.mopilot', 'worktrees');
  expect(path.dirname(path.dirname(worktree))).toBe(root);
  expect(path.basename(worktree)).toBe('demo');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  expect(branch).toMatch(/^mopilot\/[0-9a-f]{4}$/);
  expect(fs.readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8').trim()).toBe(branch);
  expect(fs.existsSync(path.join(repo, 'setup-ran.txt'))).toBe(false);

  // Settings → Worktrees lists it
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Worktrees' }).click();
  await expect(page.locator('.settings-row', { hasText: worktree })).toContainText(branch);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // archiving the chat runs the cleanup script. The chat is listed under its project and in Recents, which lists
  // every chat since #280; archiving it from the project's row takes it out of both
  const row = sidebar(page).getByText('Fake chat title', { exact: true });
  await expect(row).toHaveCount(2);
  // the row's actions show on hover, an edge: if the list re-renders under the pointer (the chat's name
  // arriving, the project group settling) the hover is gone and the button hides, so hover again
  await expect(async () => {
    await row.first().hover();
    await archiveSidebarChat(page, sidebar(page), { timeout: 3000 });
  }).toPass({ timeout: 25_000 });
  await expect(row).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(path.dirname(worktree), 'cleanup-ran.txt'))).toBe(true);
}

test.use({ harnesses: 'both' });

test('worktree-environments on Codex: worktree mode, setup first, listed in Settings, cleanup on archive', async ({ page, harness }) => {
  await journey(page, harness, 'fake-codex', () =>
    harness
      .codexLog()
      .filter((e) => e.method === 'thread/start' && !e.params.ephemeral)
      .map((e) => e.params.cwd),
  );
});

test('worktree-environments on Claude Code: worktree mode, setup first, listed in Settings, cleanup on archive', async ({
  page,
  harness,
}) => {
  await journey(page, harness, 'fake-claude', () =>
    harness.claudeLog().flatMap((e) => (e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id=')) ? [e.cwd!] : [])),
  );
});
