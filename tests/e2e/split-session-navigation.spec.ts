// Agent-opened chat splits leave with their source; sidebar navigation promotes the selected chat and retains its draft.
// e2e-covers: src/store/panes.ts src/store/split.ts src/store/splitView.ts src/store/windowLayout.ts
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import type { LayoutRequest } from '../../src/store/windowLayout';
import type { LayoutReply } from '../../src/lib/native/layout';

const ids = ['019c0000-0000-7000-8000-000000000081', '019c0000-0000-7000-8000-000000000082', '019c0000-0000-7000-8000-000000000083'];

/** Exercise the real main-to-renderer request used by open_session_in, with seeded chats instead of creating a child task. */
async function requestLayout(harness: Harness, request: LayoutRequest): Promise<LayoutReply> {
  return harness.app.evaluate(
    ({ BrowserWindow, ipcMain }, { file, request }) => {
      const { askWindow } = (process as any).mainModule.require(file);
      const win = BrowserWindow.getAllWindows().find((w) => /\/dist\/index\.html(#|$)/.test(w.webContents.getURL()))!;
      return askWindow(ipcMain, win.webContents, 'window:layout', request, 5_000);
    },
    { file: path.resolve('electron/platform/exitGate.cjs'), request },
  );
}

for (const fontSize of [14, 24]) {
  test.describe(`Split session navigation at ${fontSize}px`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: ids.map((id, i) => ({ id, name: `Split session ${i + 1}`, turns: ['Saved message'] })),
        uiState: { summaryOpen: false, prefs: { fontSize, zoomLevel: 0 } },
      },
    });

    test('switching chats removes the agent split, and selecting its chat opens it in the main pane', async ({ page, harness }, info) => {
      await sizeViewport(page, harness, 1280, 800);
      const row = (id: string) => page.getByRole('complementary').locator(`[data-sidebar-chat="${id}"]`);
      const primary = page.locator('[data-split-target="primary"]');
      const secondary = page.getByRole('region', { name: 'Secondary pane', exact: true });
      const select = async (id: string) => {
        await row(id).click();
        await expect(primary.locator('.thread-view')).toHaveAttribute('data-thread-id', id);
      };
      const room = async () => {
        await sizeViewport(page, harness, 1280, 800);
        const summary = page.getByRole('button', { name: 'Summary', exact: true });
        if ((await summary.getAttribute('class'))?.split(' ').includes('active')) await summary.click();
        await expect.poll(async () => (await page.locator('.split-frame').boundingBox())?.width ?? 0).toBeGreaterThan(720);
      };
      const openAgentPane = async () => {
        await room();
        expect(await requestLayout(harness, { op: 'split', caller: ids[0], chatId: ids[1] })).toMatchObject({ outcome: 'opened' });
        await expect(secondary.locator('.thread-view')).toHaveAttribute('data-thread-id', ids[1]);
      };

      await select(ids[0]);
      await openAgentPane();
      await sizeViewport(page, harness, 1024, 682);
      await select(ids[2]);
      await expect(secondary).toHaveCount(0);
      expect(await requestLayout(harness, { op: 'split', caller: ids[0], chatId: ids[1] })).toMatchObject({ outcome: 'not_on_screen' });
      await select(ids[0]);
      await expect(secondary).toHaveCount(0);

      await openAgentPane();
      await secondary.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this unsent reply');
      await select(ids[1]);
      await expect(secondary).toHaveCount(0);
      await expect(primary.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Keep this unsent reply');
      await sizeViewport(page, harness, 1024, 682);
      await page.screenshot({ path: info.outputPath(`selected-chat-primary-${fontSize}.png`) });

      // A normal user split remains explicitly arranged, and its close button still removes it permanently.
      await room();
      await row(ids[0]).click({ modifiers: ['Alt'] });
      await expect(secondary).toHaveCount(1);
      await select(ids[2]);
      await expect(secondary.locator('.thread-view')).toHaveAttribute('data-thread-id', ids[0]);
      await secondary.getByRole('button', { name: 'Close split view', exact: true }).click();
      await select(ids[1]);
      await expect(secondary).toHaveCount(0);
      await expect(primary.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Keep this unsent reply');
    });
  });
}
