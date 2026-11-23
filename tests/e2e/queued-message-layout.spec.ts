// Queued follow-ups share an attached composer rail, readable previews and reachable actions on every harness.
import { test, expect } from './fixtures/app';
import { controlsAreSeparate } from '../support/layoutBounds';

for (const fontSize of [14, 24]) {
  for (const family of [
    { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex' },
    { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude' },
    { label: 'ACP', harnesses: 'none', acp: { opencode: {} }, defaultHarness: 'acp:opencode' },
  ] as const) {
    test.describe(`${family.label} queue at ${fontSize}px`, () => {
      test.skip(process.platform !== 'darwin', 'ACP admission and native chat controls require macOS');
      test.use({
        harnesses: family.harnesses,
        acp: family.acp,
        seed: {
          uiState: {
            summaryOpen: true,
            prefs: {
              defaultHarness: family.defaultHarness,
              fontSize,
              zoomLevel: 0,
              followUp: 'queue',
              theme: fontSize === 14 ? 'dark' : 'light',
            },
          },
        },
      });
      test('queue, preview, edit and remove stay aligned at narrow and wide widths', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1024, height: 682 });
        const input = page.getByRole('textbox', { name: 'Message', exact: true });
        const send = page.getByRole('button', { name: 'Send', exact: true });
        const list = page.getByRole('list', { name: 'Queued messages' });
        await expect(list).toHaveCount(0);
        await input.fill('SLOW keep working while I add follow-ups');
        await send.click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        const full = 'Then review every changed file.\n\n' + 'Keep all the original details when preparing the summary. '.repeat(12);
        for (const text of ['merge to remote main', full, 'Check the release notes']) {
          await input.fill(text);
          await send.click();
        }
        const rows = list.getByRole('listitem');
        await expect(rows).toHaveCount(3);
        for (let i = 0; i < 6; i++) {
          await input.fill(`Additional queued follow-up ${i + 1}`);
          await send.click();
        }
        await expect(rows).toHaveCount(9);
        const wrap = page.locator('.composer-wrap');
        for (const width of [312, 420, 736, 312]) {
          await wrap.evaluate((el, width) => {
            (el as HTMLElement).style.width = `${width}px`;
          }, width);
          const geometry = await wrap.evaluate((el) => {
            const tray = el.querySelector('.queue-tray')!.getBoundingClientRect();
            const composer = el.querySelector('.composer')!.getBoundingClientRect();
            return {
              left: Math.abs(tray.left - composer.left),
              right: Math.abs(tray.right - composer.right),
              gap: el.querySelector('.queue-list')!.getBoundingClientRect().bottom - composer.top,
              rows: [...el.querySelectorAll('.queue-row')].map((row) => {
                const box = row.getBoundingClientRect();
                const text = row.querySelector('.queue-text')!.getBoundingClientRect();
                const actions = [...row.querySelectorAll('button')].map((button) => {
                  const { left, right, top, bottom } = button.getBoundingClientRect();
                  return { left, right, top, bottom };
                });
                return {
                  overflow: row.scrollWidth > row.clientWidth,
                  textWidth: text.width,
                  fit: actions.every((a) => a.left >= box.left && a.right <= box.right && a.top >= box.top && a.bottom <= box.bottom),
                  actions,
                };
              }),
            };
          });
          expect(geometry.left).toBeLessThanOrEqual(1);
          expect(geometry.right).toBeLessThanOrEqual(1);
          expect(geometry.gap).toBeLessThanOrEqual(0);
          for (const row of geometry.rows) {
            expect(row.overflow).toBe(false);
            expect(row.textWidth).toBeGreaterThan(100);
            expect(row.fit).toBe(true);
            expect(controlsAreSeparate(row.actions)).toBe(true);
          }
        }
        for (let i = 0; i < 6; i++) {
          await rows.last().getByRole('button', { name: 'Remove from queue', exact: true }).click();
          await expect(rows).toHaveCount(8 - i);
        }
        await expect(rows).toHaveCount(3);
        await wrap.screenshot({ path: testInfo.outputPath('queued-tray-narrow.png') });
        const chatId = await page.locator('.thread-view[data-thread-id]').getAttribute('data-thread-id');
        expect(chatId).toBeTruthy();
        await page.reload();
        // Reload opens the default page; reopen the same chat to read main's retained queue.
        await page
          .locator(`[data-sidebar-chat=${JSON.stringify(chatId)}]`)
          .first()
          .click();
        await expect(rows).toHaveCount(3);
        await wrap.evaluate((el) => {
          (el as HTMLElement).style.width = '312px';
        });
        const previewTrigger = rows.nth(1).getByRole('button', { name: /^Preview queued message:/ });
        await previewTrigger.focus();
        await previewTrigger.press('Enter');
        const preview = page.getByRole('dialog', { name: 'Queued message preview' });
        await expect(preview.locator('.queue-preview-body')).toHaveText(full);
        await expect(preview.locator('.queue-preview-body')).toBeFocused();
        await expect(rows).toHaveCount(3);
        await expect(input).toHaveText('');
        await preview.screenshot({ path: testInfo.outputPath('queued-message-preview.png') });
        await page.keyboard.press('Escape');
        await expect(preview).toHaveCount(0);
        await expect(previewTrigger).toBeFocused();
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await expect(rows).toHaveCount(3);
        await expect(list.getByRole('button', { name: 'Send', exact: true })).toHaveCount(3);
        await rows.nth(1).getByRole('button', { name: 'Queued message actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Edit message', exact: true }).click();
        await expect(rows).toHaveCount(2);
        await expect(input).toHaveText(full);
        await input.fill('');
        await rows.first().getByRole('button', { name: 'Remove from queue', exact: true }).click();
        await expect(rows).toHaveCount(1);
        await rows.first().getByRole('button', { name: 'Send', exact: true }).click();
        await expect(list).toHaveCount(0);
        await expect(page.locator('.assistant-message').last()).toContainText('Check the release notes');
      });
    });
  }
}
