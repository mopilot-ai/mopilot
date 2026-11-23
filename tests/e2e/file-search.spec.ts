// File search runs on the bundled ripgrep (electron/platform/search.cjs), so it works with no Codex.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');

test.use({ harnesses: 'claude' });

test('file-search: @ in the composer and Search Files find a file in the project, without Codex', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  // a project folder with a file to find, and one that .gitignore hides
  const folder = path.join(harness.dir, 'home', 'work', 'demo');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src', 'widgets'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'widgets', 'needle-widget.ts'), 'export {};\n');
  fs.writeFileSync(path.join(folder, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(folder, '.gitignore'), 'needle-ignored.ts\n');
  fs.writeFileSync(path.join(folder, 'needle-ignored.ts'), '');
  await harness.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, folder);
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'demo' })).toBeVisible();

  // @ mention
  await composer(page).click();
  await page.keyboard.type('look at @needwid');
  const popup = page.locator('.composer-popup');
  await expect(popup.locator('.menu-item').first()).toContainText('src/widgets/needle-widget.ts');
  await expect(popup).not.toContainText('needle-ignored.ts');
  await page.keyboard.press('Enter');
  await expect(popup).toHaveCount(0);
  await expect(composer(page)).toContainText('needle-widget.ts');

  // ⌘P: View → Search Files
  await harness.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'Search Files') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  const input = page.getByPlaceholder('Search files');
  await expect(input).toBeVisible();
  await input.fill('readme');
  await expect(page.locator('.palette-item').first()).toContainText('README.md');
  await input.press('Escape');

  // no Codex was asked to search
  expect(harness.codexLog().filter((e) => e.method === 'fuzzyFileSearch')).toEqual([]);
});
