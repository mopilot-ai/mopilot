// CUJ review-diff-and-commit on both harnesses: the agent edits a file in a git project after an approval, the
// chat shows an "Edited" card with Undo and View changes, the Changes panel lists the turn's diff, and the
// Uncommitted scope commits it with a message (checked with git itself). The reply that follows links the paths that
// exist and the #N references to the chat's repository; then a code review's Apply fixes folds its long request, walks
// the findings in the Changes pane and says where the fixes stand.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const card = (page: Page) => page.locator('.approval-card');

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, encoding: 'utf8' });

/** A git repo with one commit under HOME, returned by the folder picker, and added as a project. */
async function addRepo(page: Page, h: Harness) {
  const repo = path.join(h.dir, 'home', 'work', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  git(repo, 'init', '-q', '-b', 'main');
  // the commit the app makes needs an author: git on a Mac makes one up from the host name, on Linux it refuses
  git(repo, 'config', 'user.name', 'e2e');
  git(repo, 'config', 'user.email', 'e2e@example.com');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  // the repository bare #N references link to
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, repo);
  await sidebar(page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'repo' })).toBeVisible();
  return repo;
}

/** The edit is approved, reviewed in the Changes panel, undone and redone, then committed. */
async function reviewAndCommit(page: Page, repo: string, who: string, fake: string) {
  const hello = path.join(repo, 'hello.txt');
  await send(page, 'EDITFILE please');
  await expect(card(page)).toContainText(`Allow ${who} to edit`);
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(`${fake}: EDITFILE please [edit: written]`, { exact: true })).toBeVisible();
  expect(fs.readFileSync(hello, 'utf8')).toBe('hello\nworld\n');

  // the turn's card: what changed, with Undo and Redo
  const edited = transcript(page).locator('.edited-card');
  await expect(edited).toContainText('Edited 1 file');
  await expect(edited).toContainText('hello.txt');
  await expect(edited).toContainText('+2');
  await edited.getByRole('button', { name: /^Undo/ }).click();
  await expect(edited).toContainText('Undid changes to 1 file');
  expect(fs.existsSync(hello)).toBe(false);
  await edited.getByRole('button', { name: /^Redo/ }).click();
  await expect(edited).toContainText('Edited 1 file');
  await expect(edited).toContainText('hello.txt');
  expect(fs.readFileSync(hello, 'utf8')).toBe('hello\nworld\n');

  // View changes: the Last Turn scope lists the file with its added lines
  await edited.getByRole('button', { name: 'View changes', exact: true }).click();
  const pane = page.locator('.changes-pane');
  await expect(pane.locator('.cp-scope')).toContainText('Last Turn');
  await expect(pane.locator('.cp-file-head', { hasText: 'hello.txt' })).toContainText('+2');
  await expect(pane.locator('.cp-diffs')).toContainText('world');

  // Uncommitted: the file is untracked in the repo; commit it with a message
  await pane.locator('.cp-scope').click();
  await page
    .getByRole('menuitem', { name: 'Uncommitted changes' })
    .or(page.getByText('Uncommitted changes', { exact: true }))
    .first()
    .click();
  await expect(pane.locator('.cp-scope')).toContainText('Uncommitted');
  await expect(pane.locator('.cp-file-head', { hasText: 'hello.txt' })).toBeVisible();
  const commit = pane.getByRole('button', { name: 'Commit', exact: true });
  await expect(commit).toBeDisabled();
  await pane.getByPlaceholder('Commit message').fill('Add hello file');
  await commit.click();
  await expect(page.getByText('Committed changes')).toBeVisible();
  await expect(pane.getByText('No changes', { exact: true })).toBeVisible();
  expect(git(repo, 'log', '--format=%s', '-1').trim()).toBe('Add hello file');
  expect(git(repo, 'status', '--porcelain').trim()).toBe('');
}

/** A reply's paths link only when they exist (underlined, in the text's font), #N goes to the chat's repository. */
async function replyLinks(page: Page, h: Harness, repo: string, fake: string) {
  await send(page, 'see `hello.txt` and `src/missing.ts`, also [the file](hello.txt), this fixes #12 and acme/widgets#7');
  const answer = transcript(page)
    .locator('.md')
    .filter({ hasText: `${fake}: see` });
  await expect(answer).toContainText('acme/widgets#7');
  const file = answer.locator('a.md-path');
  await expect(file).toHaveCount(1);
  await expect(file).toHaveText('hello.txt');
  await expect(file).toHaveAttribute('title', path.join(repo, 'hello.txt'));
  await expect(file).toHaveCSS('text-decoration-line', 'underline');
  await expect(file.locator('svg')).toHaveCount(0);
  // a path that isn't there stays code
  await expect(answer.locator('code', { hasText: 'src/missing.ts' })).toBeVisible();
  await expect(answer.locator('a', { hasText: 'src/missing.ts' })).toHaveCount(0);
  await expect(answer.getByRole('link', { name: '#12', exact: true })).toHaveAttribute('href', 'https://github.com/acme/demo/issues/12');
  await expect(answer.getByRole('link', { name: 'acme/widgets#7', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/acme/widgets/issues/7',
  );
  // a Markdown link to the file: a right-click offers the path menu, and Reveal in Finder names the file (#5605)
  await h.app.evaluate(({ shell }) => {
    const g = globalThis as any;
    g.__revealed = [];
    shell.showItemInFolder = (p: string) => g.__revealed.push(p);
  });
  await answer.getByRole('link', { name: 'the file', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy path', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open with default app', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).click();
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__revealed)).toEqual([path.join(repo, 'hello.txt')]);
  // the path opens beside the conversation
  await file.click();
  await expect(page.locator('.pane-tab-body:visible')).toContainText('world');
}

/** Apply fixes: its long request folds, the walk strip says where the fixes stand, and the buttons follow it. */
async function applyFixes(page: Page, h: Harness, repo: string, who: 'Codex' | 'Claude Code') {
  fs.writeFileSync(path.join(repo, 'calc.js'), 'export const div = (a, b) => a * b;\n');
  if (who === 'Codex') {
    await composer(page).fill('/review');
    await page.keyboard.press('Enter');
    await page.getByText('Review uncommitted changes', { exact: true }).click();
  } else await send(page, '/code-review low REPORT');
  const findings = transcript(page).locator('.findings-card');
  await expect(findings.locator('.findings-meta')).toHaveText(who === 'Codex' ? '2 findings' : 'low · 2 findings');
  const applyBtn = findings.getByRole('button', { name: 'Apply fixes' });
  const walkBtn = findings.getByRole('button', { name: 'Walk through in diff' });
  await expect(applyBtn).toBeEnabled();
  // a review that finishes in the open chat walks its findings in the Changes pane
  const strip = page.locator('.changes-pane .findings-walk');
  const label = strip.locator('.findings-walk-label');
  await expect(label).toHaveText('Finding 1 of 2');
  // each finding is a note under its line in the diff
  const notes = page.locator('.changes-pane [data-finding]');
  await expect(notes).toHaveCount(2);
  await strip.getByRole('button', { name: 'Next finding' }).click();
  await expect(label).toHaveText('Finding 2 of 2');
  await strip.getByRole('button', { name: 'Previous finding' }).click();
  await expect(label).toHaveText('Finding 1 of 2');

  // the fix turn is held, so the applying state can be read
  fs.writeFileSync(path.join(h.dir, who === 'Codex' ? 'fake-codex.jsonl.hold-next' : 'fake-claude.jsonl.hold-next'), '');
  await applyBtn.click();
  await expect(label).toHaveText('Applying fixes…');
  await expect(applyBtn).toBeDisabled();
  await expect(walkBtn).toBeEnabled();
  await expect(strip.getByRole('button', { name: 'Re-run review' })).toHaveCount(0);
  // the request quotes every finding: it folds behind Show more, as Claude's app folds it
  const request = transcript(page).locator('.fold-text').filter({ hasText: 'Apply these 2 code-review findings with the minimal edits.' });
  await expect(request).toHaveClass(/clamped/);
  const more = transcript(page).getByRole('button', { name: 'Show more' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(request).not.toHaveClass(/clamped/);
  await expect(transcript(page).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');

  // the fix turn ends well: every finding is fixed, and only Re-run review is left to do
  if (who === 'Codex') fs.writeFileSync(path.join(h.dir, 'fake-codex.jsonl.release'), '');
  else h.releaseClaudeCommand();
  await expect(label).toHaveText('Fixes applied');
  // fixed findings leave the diff: no note is left under its line
  await expect(notes).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath(`fixes-applied-${who === 'Codex' ? 'codex' : 'claude'}.png`),
    animations: 'disabled',
  });
  await expect(strip.getByRole('button', { name: 'Re-run review' })).toBeVisible();
  await expect(findings.getByRole('button', { name: 'Re-run review' })).toBeVisible();
  await expect(applyBtn).toHaveCount(0);
  await expect(walkBtn).toBeDisabled();
  // Dismiss ends the walk and leaves the diff open
  await strip.getByRole('button', { name: 'Dismiss' }).click();
  await expect(strip).toHaveCount(0);
  await expect(page.locator('.changes-pane')).toBeVisible();
}

test.use({ harnesses: 'both', env: { FAKE_CODEX_REVIEW_FINDINGS: '1' } });

test('review-diff-and-commit on Codex: approve an edit, undo and redo it, review the turn, commit, follow its links, apply review fixes', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  const repo = await addRepo(page, harness);
  await reviewAndCommit(page, repo, 'Codex', 'fake-codex');
  await replyLinks(page, harness, repo, 'fake-codex');
  await applyFixes(page, harness, repo, 'Codex');
});

test('review-diff-and-commit on Claude Code: approve an edit, undo and redo it, review the turn, commit, follow its links, apply review fixes', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  const repo = await addRepo(page, harness);
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await reviewAndCommit(page, repo, 'Claude Code', 'fake-claude');
  await replyLinks(page, harness, repo, 'fake-claude');
  await applyFixes(page, harness, repo, 'Claude Code');
});
