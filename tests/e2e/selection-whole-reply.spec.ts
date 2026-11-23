// Whole replies retain their selection actions and pane-contained annotation editing on every harness family.
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/app';

async function selectWholeReply(source: Locator) {
  await source.scrollIntoViewIfNeeded();
  await source.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function expectPopupFits(popup: Locator, transcript: Locator) {
  await expect(popup).toBeVisible();
  await expect
    .poll(async () => {
      const box = await popup.boundingBox();
      const pane = await transcript.boundingBox();
      return (
        !!box &&
        !!pane &&
        box.x >= pane.x &&
        box.y >= pane.y &&
        box.x + box.width <= pane.x + pane.width + 1 &&
        box.y + box.height <= pane.y + pane.height + 1
      );
    })
    .toBe(true);
  for (const button of await popup.getByRole('button').all()) {
    await expect(button).toBeInViewport();
    const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  }
}

for (const fontSize of [14, 24]) {
  for (const family of [
    { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex' },
    { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude' },
    { label: 'ACP', harnesses: 'none', acp: { kimi: { resume: true } }, defaultHarness: 'acp:kimi' },
  ] as const) {
    test.describe(`whole reply on ${family.label} at ${fontSize}px`, () => {
      if (family.label === 'ACP') test.skip(process.platform !== 'darwin', 'ACP admission requires the macOS bridge');
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
              theme: fontSize === 14 ? 'dark' : 'light',
            },
          },
        },
      });

      test('whole-body and paragraph selections offer usable actions beside open panels', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1024, height: 682 });
        const main = page.locator('.main-content');
        const composer = main.getByRole('textbox', { name: 'Message', exact: true });
        await composer.fill('Explain this complete reply.\n\nKeep every word of this last paragraph available when I select all its text.');
        await main.getByRole('button', { name: 'Send', exact: true }).click();
        const source = main.locator('.assistant-message > [data-selection-source]').last();
        await expect(source).toContainText('Keep every word');
        await main.getByRole('button', { name: 'Fork chat from here', exact: true }).last().waitFor();
        await selectWholeReply(source);
        const transcript = main.locator('.thread-scroll');
        const toolbar = page.locator('.selection-toolbar').filter({ has: page.getByRole('group', { name: 'Selected text actions' }) });
        await expectPopupFits(toolbar, transcript);
        await expect(toolbar.getByRole('button')).toHaveText(['Start a side chat', 'Reply']);
        const bar = toolbar.getByRole('group', { name: 'Selected text actions' });
        const box = (await bar.boundingBox())!;
        expect(box.height).toBeLessThanOrEqual(fontSize === 14 ? 34 : 48);
        expect(box.width).toBeLessThanOrEqual(fontSize * 16);
        await page.screenshot({ path: testInfo.outputPath('whole-reply-actions.png') });
        await bar.screenshot({ path: testInfo.outputPath('compact-selection-actions.png') });
        const selectedText = await page.evaluate(() => window.getSelection()!.toString().trim());
        await toolbar.getByRole('button', { name: 'Start a side chat', exact: true }).focus();
        await page.keyboard.press('Tab');
        const reply = toolbar.getByRole('button', { name: 'Reply', exact: true });
        await expect(reply).toBeFocused();
        await reply.press('Enter');
        await expect(main.locator('.selection-chip')).toContainText('1 annotation');
        const comment = page.getByPlaceholder('Add an optional comment…');
        await expect(comment).toBeFocused();
        await expectPopupFits(page.locator('.annotation-comment-toolbar'), transcript);
        await comment.fill('Consider the whole response');
        await comment.press('Enter');
        await expect(composer).toBeFocused();
        const marker = page.getByRole('button', { name: 'Edit annotation 1', exact: true });
        await expect(marker).toBeVisible();
        await marker.click();
        await expect(comment).toBeFocused();
        await expect(comment).toHaveValue('Consider the whole response');
        await comment.press('Enter');
        await main.locator('.selection-chip').click();
        await expect(page.locator('.selection-pop-text').first()).toHaveText(selectedText);
        await composer.click();

        // A real paragraph gesture must keep the actions too, after the first annotation was saved.
        await source.locator('p').last().click({ clickCount: 3 });
        await expectPopupFits(toolbar, transcript);
        await toolbar.getByRole('button', { name: 'Start a side chat' }).click();
        if (family.label === 'ACP') {
          await expect(page.getByText("Side chats aren't available for this harness", { exact: true })).toBeVisible();
          await expect(main.locator('.selection-chip')).toContainText('1 annotation');
          return;
        }
        const side = page.locator('.side-pane');
        const sideComposer = side.getByRole('textbox', { name: 'Message', exact: true });
        await expect(side.locator('.selection-chip')).toContainText('1 selection');
        await sideComposer.fill('Explain this selection');
        await side.getByRole('button', { name: 'Send', exact: true }).click();
        const sideSource = side.locator('.assistant-message > [data-selection-source]').last();
        await expect(sideSource).toContainText('Explain this selection');
        await side.getByRole('button', { name: 'Fork chat from here', exact: true }).last().waitFor();
        await selectWholeReply(sideSource);
        await expectPopupFits(toolbar, side.locator('.thread-scroll'));
        await expect(toolbar.getByRole('button')).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('side-reply-actions.png') });
        await toolbar.getByRole('button', { name: 'Reply' }).click();
        await expect(comment).toBeFocused();
        await expectPopupFits(page.locator('.annotation-comment-toolbar'), side.locator('.thread-scroll'));
        await comment.fill('A note in this side chat');
        await comment.press('Enter');
        await expect(side.locator('.composer-wrap .selection-chip')).toContainText('1 annotation');
        await expect(page.locator('.annotation-marker')).toHaveCount(2);
      });
    });
  }
}
