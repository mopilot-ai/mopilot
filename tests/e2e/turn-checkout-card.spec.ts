// A branch switch while a turn runs is not that turn's edit (#2482): the turn that only ran a command shows no
// "Edited" card for the files the switch brought in, and the next turn's card lists just what it wrote.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

test.use({ harnesses: 'claude' });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const card = (page: Page) => page.locator('.approval-card');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, encoding: 'utf8' });

/** A git repo under HOME with two branches that differ in two files, added as a project; `main` is checked out. */
async function addRepo(page: Page, h: Harness) {
  const repo = path.join(h.dir, 'home', 'work', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'notes one\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'switch', '-qc', 'other');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'notes two\n');
  fs.writeFileSync(path.join(repo, 'extra.txt'), 'only on the other branch\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'switch', '-q', 'main');
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, repo);
  await sidebar(page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'repo' })).toBeVisible();
  return repo;
}

test('a switch of branch during a turn is no "Edited" card, and the next turn’s card lists only its own file', async ({
  page,
  harness,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const repo = await addRepo(page, harness);
  await sidebar(page).locator('.project-row', { hasText: 'repo' }).click();
  await send(page, 'RUNCMDSTREAM go');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  // the user switches branch in their terminal while the command runs: notes.txt changes and extra.txt appears
  git(repo, 'switch', '-q', 'other');
  expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('notes two\n');
  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText('fake-claude: RUNCMDSTREAM go', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(transcript(page).locator('.edited-card')).toHaveCount(0);

  await send(page, 'EDITFILE please');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  const edited = transcript(page).locator('.edited-card');
  await expect(edited).toContainText('Edited 1 file');
  await expect(edited).toContainText('hello.txt');
  await expect(edited).not.toContainText('notes.txt');
  await expect(edited).not.toContainText('extra.txt');
  await page.screenshot({ path: test.info().outputPath('turn-checkout-card.png') });
});
