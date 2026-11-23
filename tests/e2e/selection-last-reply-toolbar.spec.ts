// A whole paragraph of the last reply, selected by triple click, still offers the selection toolbar when the
// transcript's status row ("1 running task") follows it: Chromium ends that selection past the row, whose text is not
// selectable, and the toolbar must judge the selection by its own text, not the DOM text in between (#3449).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true }).first();

test.use({ harnesses: 'codex' });

test('triple-clicking the last reply above a running task shows Reply and Start a side chat', async ({ page }) => {
  const prompt = 'start the server BGTERM';
  await composer(page).fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  const reply = page.getByRole('main').getByText(`fake-codex: ${prompt}`, { exact: true });
  await page.getByRole('main').getByRole('button', { name: 'Fork chat from here', exact: true }).last().waitFor({ state: 'visible' });
  await expect(page.getByRole('main')).toContainText('1 running task');
  await reply.scrollIntoViewIfNeeded();

  await reply.click({ clickCount: 3 });
  // the repro: the range's end lies past the status row, whose text the selection itself leaves out
  const shape = await reply.evaluate((el) => {
    const body = el.closest('.md')!;
    const selection = window.getSelection()!;
    const between = document.createRange();
    between.setStart(body, body.childNodes.length);
    between.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    return { between: between.toString(), selected: selection.toString() };
  });
  expect(shape.between).toContain('1 running task');
  expect(shape.selected).not.toContain('running task');

  const toolbar = page.locator('.selection-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Reply' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Start a side chat' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('last-reply-toolbar.png') });
  await toolbar.getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('.selection-chip').first()).toContainText('1 annotation');
});
