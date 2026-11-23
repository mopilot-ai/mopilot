import { archiveSidebarChat } from './fixtures/sidebar';
// Worktree mode without Codex: the worktree goes under ~/.mopilot/worktrees on a mopilot/ branch, the
// project's setup script (environment.toml) runs before the Claude session starts, and cleanup runs on archive.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { writeTo } from './fixtures/scriptLine';
import { deleteWorktree } from './fixtures/worktreeDelete';
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

/** A git repo under HOME with a committed environment.toml, which the folder picker returns. */
async function pickRepo(h: Harness, rel: string) {
  const repo = path.join(h.dir, 'home', rel);
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

test.use({ harnesses: 'claude' });

test('a Claude chat in worktree mode: MoPilot root and prefix, setup before start, cleanup on archive', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  const repo = await pickRepo(harness, 'work/demo');
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'demo' })).toBeVisible();

  await page.locator('label.ctx-check', { hasText: 'Worktree' }).click();
  await expect(page.locator('label.ctx-check input')).toBeChecked();
  await composer(page).fill('hello worktree');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-claude: hello worktree', { exact: true })).toBeVisible();
  await expect(page.getByText("Couldn't connect to Codex")).toHaveCount(0);

  // the session started in <home>/.mopilot/worktrees/<id>/demo. The composer may have prewarmed a CLI in the project
  // folder before Worktree was ticked (#1664); that one is let go and never gets the prompt, so count the CLIs that did.
  const prompted = new Set(harness.claudeLog().flatMap((e) => (e.kind === 'in' && e.msg?.type === 'user' ? [e.pid] : [])));
  const sessions = harness
    .claudeLog()
    .filter((e) => e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id=')) && prompted.has(e.pid));
  const cwds = sessions.map((e) => (e.kind === 'argv' ? e.cwd! : ''));
  expect(cwds).toHaveLength(1);
  const worktree = cwds[0];
  const root = path.join(harness.dir, 'home', '.mopilot', 'worktrees');
  expect(path.dirname(path.dirname(worktree))).toBe(root);
  expect(path.basename(worktree)).toBe('demo');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  expect(branch).toMatch(/^mopilot\/[0-9a-f]{4}$/);
  // setup ran in the worktree, on its branch, before the session started
  const setupFile = path.join(worktree, 'setup-ran.txt');
  expect(fs.readFileSync(setupFile, 'utf8').trim()).toBe(branch);
  const sessionStart = sessions[0].at;
  expect(fs.statSync(setupFile).mtimeMs).toBeLessThanOrEqual(sessionStart);
  // nothing went to the old Codex locations, and the repo itself is untouched
  expect(fs.existsSync(path.join(harness.dir, 'home', '.codex', 'worktrees'))).toBe(false);
  expect(fs.existsSync(path.join(repo, 'setup-ran.txt'))).toBe(false);

  // archiving runs the cleanup script in the worktree; the chat is listed in its project and in Recents (#280), and leaves both
  const row = sidebar(page).locator('.project-group', { hasText: 'demo' }).locator('.thread-row', { hasText: 'Fake chat title' });
  await row.hover();
  await archiveSidebarChat(page, row);
  await expect(sidebar(page).getByText('Fake chat title', { exact: true })).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(path.dirname(worktree), 'cleanup-ran.txt'))).toBe(true);

  // auto-delete removed the worktree (its branch stays): unarchiving brings it back and runs setup again
  deleteWorktree(repo, worktree);
  fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
  expect(fs.existsSync(worktree)).toBe(false);
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.settings-nav .side-row', { hasText: 'Archived chats' }).click();
  await page.locator('.settings-row', { hasText: 'Fake chat title' }).getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByText(`Restored worktree on ${branch}`)).toBeVisible();
  expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe(branch);
  expect(fs.readFileSync(path.join(worktree, 'setup-ran.txt'), 'utf8').trim()).toBe(branch);
});
