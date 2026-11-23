// Image links and the Files pane decode local images, fit narrow panes and recover from broken files on every harness.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, sendAppCommand } from './fixtures/app';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4P9P4PwAHMQLLXCFjRAAAAABJRU5ErkJggg==', 'base64');
const folderName = 'image-preview';
const coverName = '封面 #1? 100%.PNG';
for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', acp: {} },
  { label: 'ACP', harnesses: 'none', acp: { kimi: { resume: true } } },
] as const) {
  test.describe(`image files on ${family.label}`, () => {
    // ACP admission needs the macOS-only sage-mcp bridge; the selector routes this complete matrix to macOS.
    if (family.label === 'ACP') test.skip(process.platform !== 'darwin', 'the ACP case requires the macOS bridge');
    test.use({ harnesses: family.harnesses, acp: family.acp, seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });

    test('opens image links, fits portrait images, enlarges, retries and returns to text', async ({ page, harness }, testInfo) => {
      const folder = path.join(harness.dir, 'home', folderName);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, coverName), png);
      fs.writeFileSync(
        path.join(folder, 'portrait.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f5b66b"/><text x="60" y="300" font-size="100">Image preview</text></svg>',
      );
      fs.writeFileSync(path.join(folder, 'broken.png'), 'not an image');
      fs.writeFileSync(path.join(folder, 'notes.md'), '# Preview recovered');
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await harness.app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
      }, folder);
      await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
      const links = [
        [coverName, 'Open cover'],
        ['portrait.svg', 'Portrait'],
        ['broken.png', 'Broken'],
        ['notes.md', 'Notes'],
      ];
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(links.map(([file, label]) => `[${label}](${pathToFileURL(path.join(folder, file)).href})`).join('\n\n'));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const reply = page.locator('.assistant-message');
      await expect(reply.getByRole('link', { name: 'Open cover', exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 682 });
      await reply.getByRole('link', { name: 'Open cover', exact: true }).click();
      const image = page.locator('.file-image-preview > img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      await image.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: `Image preview: ${coverName}`, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.lightbox')).toHaveCount(0);
      await reply.getByRole('link', { name: 'Portrait', exact: true }).click();
      await expect(image).toBeVisible();
      const geometry = await image.evaluate((el: HTMLImageElement) => {
        const r = el.getBoundingClientRect();
        const p = el.parentElement!.getBoundingClientRect();
        return {
          fits: r.width <= p.width && r.height <= p.height && r.bottom <= p.bottom && r.right <= p.right,
          width: el.naturalWidth,
          height: el.naturalHeight,
        };
      });
      expect(geometry).toEqual({ fits: true, width: 1080, height: 1920 });
      await page.screenshot({ path: testInfo.outputPath('portrait-narrow-large-font.png') });
      await reply.getByRole('link', { name: 'Broken', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Could not load image');
      fs.writeFileSync(path.join(folder, 'broken.png'), png);
      await page.getByRole('button', { name: 'Retry image preview', exact: true }).click();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
      await reply.getByRole('link', { name: 'Notes', exact: true }).click();
      await expect(page.locator('.file-markdown-preview')).toContainText('Preview recovered');
      await sendAppCommand(harness, 'toggle-files');
      await expect(page.locator('.files-tree')).toBeVisible();
      await page.locator('.files-tree').getByRole('button', { name: coverName, exact: true }).click();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
      // the file opens beside the tree, or in its place when the pane has no room for both; the tree comes back either way
      const showTree = page.getByRole('button', { name: 'Show file tree', exact: true });
      if (await showTree.isVisible()) await showTree.click();
      await expect(page.locator('.files-tree')).toBeVisible();
    });
  });
}
