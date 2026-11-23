// A linked session that worked in its own worktree offers "Merge into <branch>" on its card. While the parent chat is
// still working in that folder the button is disabled and says to wait (it used to stay clickable and answer with a
// red "This chat is working in that folder" per click); once the parent is idle it merges, and the repo is untouched
// until then.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const BRIEF =
  'This independent linked task belongs to the user’s current request. Preserve its assigned scope and report its own result to the parent session.';

const children = (h: Harness): [string, any][] => {
  try {
    return Object.entries<any>(JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8')).children ?? {});
  } catch {
    return [];
  }
};

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'claude' });

test('Merge into the parent folder waits for the parent chat, then merges', async ({ page, harness }, testInfo) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();

  const repo = path.join(harness.dir, 'home', 'work', 'merge-project');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'merge fixture\n');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', ...args], { cwd, encoding: 'utf8' });
  git(repo, 'init', '-q', '-b', 'main');
  // the merge commit the app makes needs an identity in the repo: a runner has no global one
  git(repo, 'config', 'user.name', 'e2e');
  git(repo, 'config', 'user.email', 'e2e@example.test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  await harness.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, repo);
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(page.locator('.ctxbar')).toContainText('merge-project');

  // the parent starts a session in its own worktree, which reports
  const start = `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: true,
    title: 'Merge worker',
    prompt: 'Write the notes AFTERTOOLHOLD',
    background: BRIEF,
  })}`.replace(/AFTERTOOLHOLD/g, 'AFTERTOOLH\\u004fLD');
  // (the escape keeps the marker out of the parent's own message: only the child, and later the parent's wake, hold)
  await send(page, `Start a worktree session for the notes CUSTEPS\n${start}`);
  await expect.poll(() => children(harness).length).toBe(1);
  const [, child] = children(harness)[0];

  // the child's turn is held open while its worktree gets a commit; once it ends main reads the branch facts
  fs.writeFileSync(path.join(child.cwd, 'notes.md'), 'from the worktree\n');
  git(child.cwd, 'add', '.');
  git(child.cwd, 'commit', '-q', '-m', 'notes');
  fs.writeFileSync(path.join(harness.dir, 'fake-claude.jsonl.release'), '');
  await expect.poll(() => children(harness)[0][1].lastReport, { timeout: 30_000 }).toBeTruthy();
  // main wakes the parent with the child's report, which quotes its prompt and so holds the parent's turn the same way:
  // this is the real situation behind the report, a settled child whose parent is still working
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 30_000 });
  const card = transcript(page).locator('.session-work').first();
  const merge = card.getByRole('button', { name: /Merge into main/ });
  await expect(merge).toBeDisabled({ timeout: 30_000 });
  await expect(card).toContainText('Wait until this chat is idle before merging.');
  expect(fs.existsSync(path.join(repo, 'notes.md'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('merge-disabled-while-woken-parent-works.png') });
  fs.writeFileSync(path.join(harness.dir, 'fake-claude.jsonl.release'), '');
  await expect(merge).toBeEnabled({ timeout: 30_000 });
  await expect(card).not.toContainText('Wait until this chat is idle before merging.');

  // the parent starts a turn that keeps working: the card now says to wait and the button cannot be clicked
  await send(page, 'keep working in this folder SLOW');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(merge).toBeDisabled();
  await expect(card).toContainText('Wait until this chat is idle before merging.');
  expect(fs.existsSync(path.join(repo, 'notes.md'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('merge-disabled-while-parent-works.png') });

  // Stop ends the parent's turn; the button comes back and the merge lands in the parent's folder
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(merge).toBeEnabled({ timeout: 30_000 });
  await expect(card).not.toContainText('Wait until this chat is idle before merging.');
  // the app's own git readers (the Changes panel) can hold the index for a moment; a click that meets that says
  // "Unable to write index" and changes nothing, so the click is repeated
  const merged = () => fs.existsSync(path.join(repo, 'notes.md'));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (merged()) break;
    await merge.click();
    await expect
      .poll(merged, { timeout: 8_000 })
      .toBe(true)
      .catch(() => undefined);
  }
  expect(merged()).toBe(true);
  expect(git(repo, 'log', '--oneline').split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath('merge-after-parent-idle.png') });
});
