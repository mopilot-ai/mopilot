// Conversation chat links reuse their window on Cmd/Ctrl-click and preserve the source draft and navigation history.
// e2e-covers: src/components/markdown/ChatLink.tsx src/session/openChat.ts
import { test, expect, sendAppCommand } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { captureExternal } from './fixtures/externalUrls';

const SOURCE = '019c0000-0000-7000-8000-000000000091';
const REPAIR = '019c0000-0000-7000-8000-000000000092';

for (const fontSize of [14, 24]) {
  test.describe(`Conversation links at ${fontSize}px`, () => {
    test.use({
      seed: {
        codexThreads: [
          { id: SOURCE, name: 'Source conversation', turns: ['Original message'] },
          { id: REPAIR, name: 'Red main issue #5330', turns: ['Repair in progress'] },
        ],
        uiState: { summaryOpen: true, prefs: { fontSize, zoomLevel: 0 } },
      },
    });

    test('Cmd/Ctrl-clicking the repair link stays in this window and Back preserves the draft', async ({ page, harness }, info) => {
      test.skip(process.platform !== 'darwin', 'Reproduces the reported native macOS Cmd-click behavior.');
      await sizeViewport(page, harness, fontSize === 24 ? 1024 : 1280, fontSize === 24 ? 682 : 800);
      await page.getByRole('complementary').locator(`[data-sidebar-chat="${SOURCE}"]`).click();
      const primary = page.locator('[data-split-target="primary"]');
      const composer = primary.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill(`The repair is running in [Red main issue #5330](mopilot:chat/${REPAIR}).`);
      await primary.getByRole('button', { name: 'Send', exact: true }).click();
      const link = primary.locator('.assistant-message button.md-chat-link');
      await expect(link).toHaveText('Red main issue #5330');
      await composer.fill('Keep this unsent reply');
      const windowCount = harness.app.windows().length;
      const external = await captureExternal(harness);
      const created: unknown[] = [];
      const onWindow = (win: unknown) => created.push(win);
      harness.app.on('window', onWindow);
      try {
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        for (const modifiers of [[], [modifier], [modifier]] as ('Meta' | 'Control')[][]) {
          await link.click({ modifiers });
          await expect(primary.locator('.thread-view')).toHaveAttribute('data-thread-id', REPAIR);
          expect(harness.app.windows()).toHaveLength(windowCount);
          await sendAppCommand(harness, 'back');
          await expect(primary.locator('.thread-view')).toHaveAttribute('data-thread-id', SOURCE);
          await expect(composer).toHaveText('Keep this unsent reply');
        }
        expect(created).toHaveLength(0);
        expect(await external()).toEqual([]);
        await page.screenshot({ path: info.outputPath(`repair-link-current-window-${fontSize}.png`) });
      } finally {
        harness.app.off('window', onWindow);
      }
    });
  });
}
