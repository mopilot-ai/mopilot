// Default folds retain concurrent work across reload, then shrink after completion without changing manual order.
// e2e-covers: src/components/sidebar/useRequiredChats.ts src/components/sidebar/chatWindow.ts src/components/sidebar/WindowFoot.tsx
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/ChatLists.tsx
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const ids = Array.from({ length: 35 }, (_, i) => `019c0000-0000-7000-8000-${String(i).padStart(12, '0')}`);

for (const mode of ['project', 'list', 'recents'] as const) {
  for (const fontSize of [14, 24]) {
    test.describe(`${mode} fold at font ${fontSize}`, () => {
      test.use({
        harnesses: 'codex',
        seed: {
          codexThreads: ids.map((id, i) => ({
            id,
            name: `Session ${i}`,
            cwd: mode === 'recents' ? undefined : 'work/fold',
            turns: ['Ready'],
          })),
          uiState: {
            summaryOpen: true,
            prefs: {
              fontSize,
              zoomLevel: 0,
              chatSort: 'manual',
              chatOrder: { fold: ids, '@list': ids, '@recents': ids },
              sidebarOrganize: mode === 'list' ? 'list' : 'project',
            },
          },
          files: ({ home, userData }) => {
            if (mode === 'recents') return;
            const folder = path.join(home, 'work', 'fold');
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(
              path.join(userData, 'projects.json'),
              JSON.stringify({ projects: [{ id: 'fold', name: 'fold', path: folder }] }),
            );
          },
        },
      });

      test('running sessions remain outside Show more after folding and reloading', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1024, height: 682 });
        const sidebar = page.getByRole('complementary');
        const list =
          mode === 'project'
            ? sidebar.locator('.project-group').filter({ has: page.locator('.project-row .side-row-label', { hasText: /^fold$/ }) })
            : sidebar
                .locator('.sidebar-section')
                .filter({ has: page.locator('.side-label', { hasText: mode === 'list' ? /^Projects$/ : /^Recents$/ }) });
        const rows = list.locator('[data-sidebar-chat]');
        const row = (at: number) => list.locator(`[data-sidebar-chat="${ids[at]}"]`);
        const foot = list.locator('.show-more');
        const first = mode === 'list' ? 20 : 5;
        await expect(rows).toHaveCount(first);
        for (let shown = first; shown < ids.length; shown += 5) {
          await expect(foot).toHaveText('Show 5 more');
          await foot.click();
          await expect(rows).toHaveCount(shown + 5);
        }
        await expect(foot).toHaveText('Show less');
        for (const at of [first + 1, first + 5]) {
          await row(at).click();
          await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`SLOW session ${at}`);
          await page.getByRole('button', { name: 'Send', exact: true }).click();
          await expect(page.locator('.send-btn.stop')).toBeVisible();
        }
        await row(0).click();
        await foot.click();
        await expect(rows).toHaveCount(first + 6);
        await expect(row(first + 1).locator('.row-dot.working')).toBeVisible();
        await expect(row(first + 5).locator('.row-dot.working')).toBeVisible();
        await page.reload();
        await expect(rows).toHaveCount(first + 6);
        await expect(row(first + 5).locator('.row-dot.working')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('active-sessions-above-fold.png') });
        for (const at of [first + 1, first + 5]) {
          await row(at).click();
          await page.locator('.send-btn.stop').click();
          await expect(page.locator('.send-btn.stop')).toHaveCount(0);
        }
        await row(0).click();
        await expect(rows).toHaveCount(first);
      });
    });
  }
}
