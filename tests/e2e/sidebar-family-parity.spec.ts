// CD sidebar-family journey: rounded single-level guide, persisted folding, menu detach and explicit parent-only archive.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { archiveSidebarChat, chooseSidebarChatAction } from './fixtures/sidebar';

const ROOT = '019c0000-0000-7000-8000-000000000001';
const CHILD = '019c0000-0000-7000-8000-000000000002';
const GRAND = '019c0000-0000-7000-8000-000000000003';
const SECOND = '019c0000-0000-7000-8000-000000000004';
const ids = [ROOT, CHILD, GRAND, SECOND];

for (const fontSize of [14, 24]) {
  test.describe(`CD sidebar families at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: ids.map((id, i) => ({
          id,
          name: ['Family parent', 'First worker', 'Grandchild worker', 'Second worker'][i],
          turns: [`Family message ${i}`],
        })),
        uiState: { summaryOpen: true, prefs: { fontSize, zoomLevel: 0 } },
        files: ({ userData }) => {
          const children = Object.fromEntries(
            ids.slice(1).map((id, i) => [
              id,
              {
                parentId: id === GRAND ? CHILD : ROOT,
                name: `worker-${i}`,
                title: 'Worker',
                harness: 'codex',
                useWorktree: false,
                cwd: '',
                createdAt: i + 1,
                driven: [],
                lastReport: null,
              },
            ]),
          );
          fs.writeFileSync(
            path.join(userData, 'orchestration.json'),
            JSON.stringify({
              schemaVersion: 1,
              children,
              parents: {},
              deliveries: {},
              proposals: {},
              queue: [],
              plans: {},
              wrapUps: {},
              dependants: {},
            }),
          );
        },
      },
    });

    test('one family guide survives fold/reload and menu actions preserve detached and retained workers', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const sidebar = page.getByRole('complementary');
      const recents = sidebar.locator('.sidebar-section').filter({ has: page.getByRole('button', { name: 'Recents', exact: true }) });
      const row = (id: string) => recents.locator(`[data-sidebar-chat="${id}"]`);
      const parent = row(ROOT);
      const family = recents.locator('.side-children');
      await expect(parent).toBeVisible();
      await expect(family).toHaveCount(1);
      await expect(family.locator('.thread-row')).toHaveCount(3);
      const geometry = await family.evaluate((element) => {
        const guide = getComputedStyle(element, '::after');
        const bounds = element.getBoundingClientRect();
        const rows = Array.from(element.querySelectorAll<HTMLElement>('.thread-row'));
        const last = rows.at(-1)!.getBoundingClientRect();
        return {
          border: guide.borderInlineStartWidth,
          radius: guide.borderEndStartRadius,
          arm: guide.width,
          endpoint: bounds.bottom - Number.parseFloat(guide.bottom),
          lastMidpoint: last.top + last.height / 2,
          depths: rows.map((node) => node.style.getPropertyValue('--depth')),
          rowStrokes: rows.map((node) => getComputedStyle(node, '::before').content),
        };
      });
      expect(geometry.border).toBe('1px');
      expect(geometry.radius).toBe('6px');
      expect(geometry.arm).toBe('10px');
      expect(geometry.depths).toEqual(['1', '1', '1']);
      expect(geometry.rowStrokes.every((content) => content === 'none' || content === 'normal')).toBe(true);
      expect(Math.abs(geometry.endpoint - geometry.lastMidpoint)).toBeLessThan(1);
      await testInfo.attach('family-guide-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
      await expect(parent.locator('.nested-caret')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`family-expanded-font${fontSize}.png`) });

      await parent.getByRole('button', { name: 'Hide nested sessions' }).click();
      await expect(family.locator('.thread-row')).toHaveCount(0);
      await expect(family.locator('.nested-summary')).toContainText('3 nested sessions');
      await page.reload();
      await expect(family.locator('.nested-summary')).toContainText('3 nested sessions');
      await family.locator('.nested-summary').click();
      await expect(family.locator('.thread-row')).toHaveCount(3);

      await row(GRAND).hover();
      await row(GRAND).click();
      await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Utilities', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Detach to top level', exact: true }).click();
      await expect(row(GRAND)).not.toHaveClass(/linked-child/);
      await expect(family.locator('.thread-row')).toHaveCount(2);
      await page.reload();
      await expect(row(GRAND)).not.toHaveClass(/linked-child/);
      await row(CHILD).hover();
      await chooseSidebarChatAction(page, row(CHILD), 'Pin');
      await parent.hover();
      await archiveSidebarChat(page, parent);
      const choice = page.getByRole('alertdialog', { name: 'Archive session?' });
      await expect(choice).toContainText('2 nested sessions');
      await expect(choice.getByRole('button', { name: 'Archive all 3 sessions' })).toBeVisible();
      await choice.getByRole('button', { name: 'Archive this session', exact: true }).click();
      await expect(parent).toHaveCount(0);
      for (const id of [CHILD, GRAND, SECOND]) {
        await expect(row(id)).toBeVisible();
        await expect(row(id)).not.toHaveClass(/linked-child/);
      }
      await expect(family).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`family-detached-font${fontSize}.png`) });
    });
  });
}
