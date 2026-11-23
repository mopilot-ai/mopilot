// Hide stale local sidebar groups without orphaning history; revalidate their restoration through the real IPC.
// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/useFolderAvailability.ts electron/platform/projectPaths.cjs electron/session/chatFolderGuard.cjs
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';

test.use({
  harnesses: 'claude',
  seed: {
    uiState: { prefs: { pinnedProjects: ['saved'] } },
    claudeSessions: [
      { id: '11111111-1111-4111-8111-111111111111', cwd: 'ccprobe/work', title: 'Saved history', turns: ['preserve saved history'] },
      {
        id: '22222222-2222-4222-8222-222222222222',
        cwd: 'ccprobe/discovered',
        title: 'Discovered history',
        turns: ['preserve discovered history'],
      },
    ],
    files: ({ home, userData }) => {
      fs.writeFileSync(
        path.join(userData, 'projects.json'),
        JSON.stringify({
          projects: [{ id: 'saved', name: 'work', path: path.join(home, 'ccprobe/work') }],
        }),
      );
    },
  },
});

test('deleted folders disappear, their history still opens and refuses send, and restored folders reappear', async ({ page, harness }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  const rows = page.getByRole('complementary').locator('.project-row .side-row-label');
  const recents = page.locator('[data-shortcut-recents]');
  await expect(rows).toHaveText(['work', 'discovered']);
  await recents.locator('.thread-row', { hasText: 'Saved history' }).click();
  await expect(page.getByRole('main')).toContainText('preserve saved history');
  const folders = ['work', 'discovered'].map((name) => path.join(harness.dir, 'home', 'ccprobe', name));
  // Only this isolated fixture's empty folders are removed, not transcripts or project state.
  for (const folder of folders) fs.rmdirSync(folder);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(rows).toHaveCount(0);
  await expect(recents.locator('.thread-row.selected')).toContainText('Saved history');
  await send(page, 'keep this message while the folder is gone');
  await expect(page.getByRole('main')).toContainText(`This chat's folder no longer exists: "${folders[0]}"`);
  await recents.locator('.thread-row', { hasText: 'Discovered history' }).click();
  await expect(page.getByRole('main')).toContainText('preserve discovered history');
  await page.screenshot({ path: test.info().outputPath('hidden-folders-history-retained.png') });
  const saved = JSON.parse(fs.readFileSync(path.join(harness.dir, 'userData', 'projects.json'), 'utf8'));
  expect(saved.projects.some((p: { id: string }) => p.id === 'saved')).toBe(true);
  for (const folder of folders) fs.mkdirSync(folder);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(rows).toHaveText(['work', 'discovered']);
  await harness.relaunch();
  await expect(harness.page.getByRole('complementary').locator('.project-row .side-row-label')).toHaveText(['work', 'discovered']);
});
