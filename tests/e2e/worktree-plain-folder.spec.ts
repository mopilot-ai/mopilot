// A project folder that isn't a git repository: the new-chat bar and its / menu offer no Worktree switch (nothing to
// choose there), and a session the agent proposes in its own worktree says it runs in the folder and starts there
// (main can't make a worktree of the folder, so a worktree start would fail with "Couldn't start").
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const slashTitles = (page: Page) => page.locator('.slash-panel .add-panel-title');

/** The orchestration journal main keeps (userData/orchestration.json). */
const children = (h: Harness): any[] => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8')).children ?? {});
  } catch {
    return [];
  }
};

/** A plain folder (no git) under HOME, which the folder picker returns. */
async function pickPlainFolder(h: Harness, rel: string) {
  const dir = path.join(h.dir, 'home', rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'plain\n');
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, dir);
  return dir;
}

test.use({ harnesses: 'claude' });

test('a folder outside git: no Worktree switch or / entry, and a session proposed in a worktree starts in the folder', async ({
  page,
  harness,
}) => {
  await expect(composer(page)).toBeVisible();
  const folder = await pickPlainFolder(harness, 'work/plain');
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'plain' })).toBeVisible();
  await expect(page.locator('.ctxbar')).toContainText('plain');
  // the folder's branch list answers well within this; before, a greyed-out Worktree switch stayed in the bar
  await page.waitForTimeout(1500);
  await expect(page.locator('.ctxbar .ctx-wt')).toHaveCount(0);
  await expect(page.locator('label.ctx-check', { hasText: 'Worktree' })).toHaveCount(0);
  await composer(page).fill('/work');
  await expect(slashTitles(page).filter({ hasText: 'Work in a project' })).toBeVisible();
  await expect(slashTitles(page).filter({ hasText: /^Worktree$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // explicitly propose its own worktree, exercising the plain-folder fallback (CUSTEPS shows its tool card)
  const propose = `CUCALL start_session ${JSON.stringify({
    initiation: 'own_initiative',
    context: 'fresh',
    use_worktree: true,
    title: 'PLAINWT docs',
    prompt: 'Write the docs',
    background:
      'This documentation task belongs to the current user request. Preserve the assigned folder and report its result without changing the parent task.',
  })}`;
  await composer(page).fill(['suggest a docs session CUSTEPS', propose].join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const row = page.locator('.suggest-row', { hasText: 'PLAINWT docs' });
  await expect(row.locator('.suggest-row-place')).toHaveText('In this folder');
  // where the row runs opens its start options
  await row.getByRole('button', { name: 'In this folder' }).click();
  const options = page.getByRole('dialog', { name: 'Session start options', exact: true });
  await expect(options.getByRole('combobox', { name: 'Harness', exact: true })).toBeVisible();
  await expect(options.getByRole('checkbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await row.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => children(harness).map((c) => [c.title, c.cwd, c.useWorktree])).toEqual([['PLAINWT docs', folder, false]]);
  await expect(page.getByText('Couldn’t start')).toHaveCount(0);
});
