// Sidebar PR/activity columns stay anchored at minimum width through nesting, multiple PRs, hover, shortcuts and reload.
// e2e-covers: src/styles/app/sidebar.css
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { fakeGhBin } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const PARENT = '019c0000-0000-7000-8000-000000000091';
const CHILD = '019c0000-0000-7000-8000-000000000092';
const EMPTY = '019c0000-0000-7000-8000-000000000093';
const { dir: BIN } = fakeGhBin(fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-pr-gh-')));
const opened = (n: number) => `Opened pull request https://github.com/acme/demo/pull/${n}`;

/** The PR glyph's and the trailing slot's x: a hovered row's menu fills the status slot, overhanging it 3px a side. */
async function columns(row: Locator) {
  const glyph = (await row.locator('.thread-pr-icon').boundingBox())!;
  const status = row.locator('.row-status');
  const menu = await status.isHidden();
  const slot = (await (menu ? row.locator('.row-actions') : status).boundingBox())!;
  const bounds = (await row.boundingBox())!;
  expect(slot.x + slot.width - (menu ? 3 : 0)).toBeLessThanOrEqual(bounds.x + bounds.width);
  return { pr: glyph.x, activity: slot.x + (menu ? 3 : 0) };
}

for (const fontSize of [14, 24]) {
  test.describe(`minimum sidebar at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      shellPath: [BIN],
      env: { PATH: withPath([BIN]) },
      seed: {
        codexThreads: [
          { id: PARENT, name: 'Single pull request', turns: [opened(1)] },
          { id: CHILD, name: 'Several pull requests', turns: Array.from({ length: 10 }, (_, i) => opened(i + 2)) },
          { id: EMPTY, name: 'No pull request', turns: ['An ordinary saved reply'] },
        ],
        uiState: { summaryOpen: true, prefs: { fontSize, sidebarWidth: 200, zoomLevel: 0 } },
        files: ({ userData }) => {
          fs.writeFileSync(
            path.join(userData, 'orchestration.json'),
            JSON.stringify({
              schemaVersion: 1,
              children: {
                [CHILD]: {
                  parentId: PARENT,
                  name: 'worker',
                  title: 'Several pull requests',
                  harness: 'codex',
                  useWorktree: false,
                  createdAt: 1,
                  driven: [],
                  lastReport: null,
                },
              },
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

    test('PR glyphs and session slots stay aligned through hover, shortcut hints and reopen', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const sidebar = page.getByRole('complementary');
      const row = (id: string) => sidebar.locator(`[data-sidebar-chat="${id}"]`).first();
      const parent = row(PARENT);
      const child = row(CHILD);
      await expect(parent.locator('.thread-pr-badge')).toBeVisible();
      await expect(child.locator('.thread-pr-count')).toHaveText('10');
      await expect(row(EMPTY).locator('.thread-pr-badge')).toHaveCount(0);
      await page.mouse.move(900, 40);
      const anchor = await columns(parent);
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      expect(await columns(child)).toEqual(anchor);
      const idle = (await row(EMPTY).locator('.row-status').boundingBox())!;
      expect(idle.x).toBe(anchor.activity);
      for (const target of [parent, child]) {
        await target.hover();
        await expect(target.getByRole('button', { name: 'More options', exact: true })).toBeVisible();
        await expect(target.locator('.row-status')).toBeHidden();
        expect(await columns(target)).toEqual(anchor);
        await page.keyboard.down(modifier);
        try {
          await expect(target.locator('.chat-shortcut-hint')).toBeVisible();
          await expect(target.getByRole('button', { name: 'More options', exact: true })).toBeHidden();
          expect(await columns(target)).toEqual(anchor);
        } finally {
          await page.keyboard.up(modifier);
        }
      }
      await child.locator('.thread-pr-badge').hover();
      await expect(page.locator('.tooltip.rich .thread-pr-list-item')).toHaveCount(10);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-pr-columns-font${fontSize}.png`) });
      await page.mouse.move(900, 40);
      if (fontSize === 24) {
        // Occupy the same row space as a location column plus an inbox badge without waiting for a live request.
        const extraMarks = await child.evaluateHandle((el) => {
          const marks = document.createElement('span');
          marks.style.flex = '0 0 44px';
          marks.setAttribute('aria-hidden', 'true');
          el.querySelector('.thread-pr-badge')!.parentElement!.before(marks);
          return marks;
        });
        expect(await columns(child)).toEqual(anchor);
        await child.hover();
        expect(await columns(child)).toEqual(anchor);
        await extraMarks.evaluate((el) => el.remove());
        await extraMarks.dispose();
        await page.mouse.move(900, 40);
      }
      await parent.focus();
      await parent.press('Enter');
      await expect(parent).toHaveAttribute('aria-current', 'page');
      await child.focus();
      await child.press('Enter');
      await expect(child).toHaveAttribute('aria-current', 'page');
      await page.reload();
      await expect(child.locator('.thread-pr-count')).toHaveText('10');
      expect(await columns(child)).toEqual(await columns(parent));
    });
  });
}
