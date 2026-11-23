// Loading an older Codex history page appends newly discovered folders without moving the user's custom projects, listed or not.
// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/Sidebar.tsx src/components/sidebar/ProjectGroup.tsx
// e2e-covers: src/store/projects.ts src/components/sidebar/homeTarget.ts
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

for (const fontSize of [14, 24]) {
  test.describe(`history discovery at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        uiState: { prefs: { fontSize, zoomLevel: 0, projectSort: 'custom', sidebarProjectOrder: ['beta', 'alpha'] } },
        codexThreads: Array.from({ length: 103 }, (_, i) => ({
          id: `019c0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
          name: `History chat ${i}`,
          cwd: i < 100 ? 'work/alpha' : `work/old-${i}`,
          turns: [`Historical message ${i}`],
        })),
        files: ({ home, userData }) => {
          for (const name of ['alpha', 'beta', 'old-100', 'old-101', 'old-102'])
            fs.mkdirSync(path.join(home, 'work', name), { recursive: true });
          fs.writeFileSync(
            path.join(userData, 'projects.json'),
            JSON.stringify({
              schemaVersion: 1,
              projects: ['alpha', 'beta'].map((name) => ({ id: name, name, path: path.join(home, 'work', name), source: 'sage' })),
            }),
          );
        },
      },
    });

    test('older folders stay below the custom order during pagination and after restart', async ({ page, harness }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const labels = () => harness.page.locator('.project-group > .project-row .side-row-label');
      const prefs = () => JSON.parse(fs.readFileSync(path.join(harness.dir, 'userData', 'ui-state.json'), 'utf8')).prefs;
      // beta has no chat, so it is not listed, but it keeps its place in the custom order (checked below)
      await expect(labels()).toHaveText(['alpha']);
      // dispatchEvent, not click(): click() scrolls the button into view, and a sidebar scrolled to its end loads the next
      // page by itself, which can remove the button under the click and leave it waiting for a button that is gone.
      await page.getByRole('button', { name: 'Show more chats', exact: true }).dispatchEvent('click');
      const names = ['alpha', 'old-100', 'old-101', 'old-102'];
      const order = ['beta', 'alpha', ...names.slice(1).map((name) => path.join(harness.dir, 'home', 'work', name))];
      await expect(labels()).toHaveText(names);
      await expect.poll(() => prefs().sidebarProjectOrder).toEqual(order);
      expect(harness.codexLog().some((e) => e.method === 'thread/list' && e.params.cursor === '100')).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`history-order-font${fontSize}.png`) });
      await harness.relaunch();
      await harness.page.setViewportSize({ width: 1024, height: 682 });
      await expect(labels()).toHaveText(names);
      expect(prefs().sidebarProjectOrder).toEqual(order);
    });
  });
}
