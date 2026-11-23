// Deleted worktrees under a symlink keep their chats in one saved project across app restarts.
// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/useFolderAvailability.ts
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const titles = ['docs(coordination): align agent workflow', 'feat(foundation): add contracts', 'Sage implementation'];
const worktrees = ['review', 'foundation', 'implementation'];

test.use({
  harnesses: 'both',
  seed: {
    codexThreads: [{ id: '019b0000-0000-7000-8000-000000000001', cwd: 'Projects/Sage', name: 'Main checkout', turns: ['main'] }],
    claudeSessions: titles.map((title, i) => ({
      id: `11111111-1111-4111-8111-11111111111${i}`,
      cwd: `Documents/ChatGPT/Sage/.claude/worktrees/${worktrees[i]}`,
      title,
      turns: [title],
    })),
    files: ({ home, userData }) => {
      const root = path.join(home, 'Projects', 'Sage');
      const alias = path.join(home, 'Documents', 'ChatGPT', 'Sage');
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(root, alias, 'junction');
      fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ projects: [{ id: 'sage', name: 'Sage', path: alias }] }));
    },
  },
});

test('deleted worktree chats reuse the saved Sage row, stay accessible and retain its collapse state', async ({ harness }) => {
  const rows = () => harness.page.getByRole('complementary').locator('.project-row[aria-label="Sage"]');
  const group = () => rows().locator('..');
  await expect(group().locator('.thread-row')).toHaveCount(4);
  await harness.quit();
  for (const name of worktrees)
    fs.rmSync(path.join(harness.env.HOME, 'Documents', 'ChatGPT', 'Sage', '.claude', 'worktrees', name), { recursive: true });
  await harness.relaunch();
  await harness.page.setViewportSize({ width: 1024, height: 682 });
  await expect(group().locator('.thread-row')).toHaveCount(4);
  await expect(rows()).toHaveCount(1);
  for (const title of titles) {
    const chat = group().locator('.thread-row').filter({ hasText: title });
    await chat.click();
    await expect(chat).toHaveClass(/selected/);
  }
  await harness.page.screenshot({ path: test.info().outputPath('one-sage-project.png') });
  await rows().click();
  await expect(rows()).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(() => JSON.parse(fs.readFileSync(path.join(harness.env.MOPILOT_USER_DATA, 'ui-state.json'), 'utf8')).collapsedProjects?.sage)
    .toBe(true);
  await harness.relaunch();
  await expect(rows()).toHaveCount(1);
  await expect(rows()).toHaveAttribute('aria-expanded', 'false');
  await rows().click();
  await expect(group().locator('.thread-row')).toHaveCount(4);
});
