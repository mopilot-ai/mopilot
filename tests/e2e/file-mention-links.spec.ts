// An @-mentioned file reads as a link, as in Claude's app: one accent chip in the composer, accent link text with its `@`
// in the sent bubble that opens the file in the pane, and plain text for a name that is no file there (#4581).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const bubble = (page: Page, text: string) => page.locator('.user-bubble', { hasText: text });

async function project(h: Harness) {
  const folder = path.join(h.dir, 'home', 'work', 'design');
  fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Design1_MenggeWang.pdf'), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(folder, 'docs', 'notes.md'), '# Review notes\n\nThe header needs work.\n');
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(h.page).getByRole('button', { name: 'Add new project' }).click();
  await expect(h.page.getByRole('button', { name: 'Change project: design' })).toBeVisible();
}

test.use({ harnesses: 'claude', seed: { uiState: SYSTEM_THEME } });

test('an @ file is a chip in the composer and an accent link in the bubble that opens it; a name stays text', async ({ page, harness }) => {
  test.setTimeout(120_000);
  await project(harness);
  await composer(page).click();
  await page.keyboard.type('@Design1');
  await expect(page.locator('.composer-popup .menu-item').first()).toContainText('Design1_MenggeWang.pdf');
  await page.keyboard.press('Enter');
  await page.keyboard.type('看看这个');
  // the pick is one uneditable accent chip holding the @path; the draft reads as the harness gets it
  const chip = composer(page).locator('.composer-file-token');
  await expect(chip).toHaveText('@Design1_MenggeWang.pdf');
  await expect(chip).toHaveAttribute('contenteditable', 'false');
  await expect(composer(page)).toHaveText('@Design1_MenggeWang.pdf 看看这个');
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(chip).toHaveCSS('color', accent);
  await shootBoth(page, harness.app, 'file-mention-composer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

  // the bubble: the @path as accent link text, underlined on hover, the rest of the sentence plain
  const link = bubble(page, '看看这个').locator('a.bubble-file-link');
  await expect(link).toHaveText('@Design1_MenggeWang.pdf');
  await expect(link).toHaveCSS('color', accent);
  await expect(link).toHaveCSS('text-decoration-line', 'none');
  await link.hover();
  await expect(link).toHaveCSS('text-decoration-line', 'underline');
  await shootBoth(page, harness.app, 'file-mention-bubble');
  // a click opens it in the side pane
  await link.click();
  await expect(page.locator('.side-pane')).toContainText('Design1_MenggeWang.pdf', { timeout: 30_000 });
  await shootBoth(page, harness.app, 'file-mention-opened');

  // a typed mention of a file in a folder links too, and opens its content; a name and mail stay text
  await composer(page).click();
  await page.keyboard.type('再看 @docs/notes.md，问 @john.doe 或 me@x.com');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  const sent = bubble(page, '再看');
  await expect(sent.locator('a.bubble-file-link')).toHaveText(['@docs/notes.md']);
  await expect(sent).toContainText('问 @john.doe 或 me@x.com');
  await sent.locator('a.bubble-file-link').click();
  await expect(page.locator('.side-pane')).toContainText('The header needs work.', { timeout: 30_000 });
  await shootBoth(page, harness.app, 'file-mention-notes');
});
