// All rich file types traverse real message links and local decoders on every harness in an isolated app.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, sendAppCommand } from './fixtures/app';
import { writePreviewFiles } from '../fixtures/previewFiles';

for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', acp: {} },
  { label: 'ACP', harnesses: 'none', acp: { kimi: { resume: true } } },
] as const)
  test.describe(`rich files on ${family.label}`, () => {
    // ACP admission needs the macOS-only sage-mcp bridge; the selector routes this complete matrix to macOS.
    if (family.label === 'ACP') test.skip(process.platform !== 'darwin', 'the ACP case requires the macOS bridge');
    test.use({ harnesses: family.harnesses, acp: family.acp, seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });
    test('previews documents, sheets, HTML, media and images with recovery and narrow layout', async ({ page, harness }, testInfo) => {
      test.setTimeout(120_000);
      const folder = path.join(harness.dir, 'home', 'preview-files');
      await writePreviewFiles(folder);
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await harness.app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
      }, folder);
      await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
      const files = [
        'document.pdf',
        'cjk.pdf',
        'jpeg2000.pdf',
        'broken.pdf',
        'document.docx',
        'slides.pptx',
        'book.xlsx',
        'book.xls',
        'legacy-word.doc',
        'legacy.ppt',
        'table.csv',
        'table.tsv',
        'page.html',
        'video.mp4',
        'video.webm',
        'audio.wav',
        'image.bmp',
        'image.avif',
      ];
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(files.map((name) => `[${name}](${pathToFileURL(path.join(folder, name)).href})`).join('\n\n'));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const reply = page.locator('.assistant-message');
      await expect(reply.getByRole('link', { name: 'document.pdf', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await page.setViewportSize({ width: 1024, height: 682 });
      // Styled scrollbars exercise classic reserved space; the theme can still choose a thin width.
      await page.addStyleTag({ content: '.pdf-page-scroll::-webkit-scrollbar { width: 18px; height: 18px; }' });
      const open = async (name: string) => reply.getByRole('link', { name, exact: true }).click();
      await open('document.pdf');
      await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
      await expect
        .poll(() =>
          page.locator('.pdf-page-scroll').evaluate((el) => {
            const style = getComputedStyle(el);
            return el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
          }),
        )
        .toBeGreaterThan(0);
      await page.getByLabel('PDF zoom', { exact: true }).selectOption('1.5');
      await expect(
        page.getByRole('img', { name: 'PDF page 2', exact: true }).or(page.locator('canvas[aria-label="PDF page 2"]')),
      ).toBeVisible();
      const summary = page.locator('.pdf-page-text summary');
      const summaryNode = await summary.elementHandle();
      await summary.click();
      await expect(page.locator('.pdf-page-text')).toContainText('Second PDF page');
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await summaryNode!.evaluate((el) => el.isConnected)).toBe(true);
      await expect(page.locator('.pdf-page-text')).toHaveAttribute('open', '');
      await open('cjk.pdf');
      await page.locator('.pdf-page-text summary').click();
      await expect(page.locator('.pdf-page-text')).toContainText('東京');
      await open('jpeg2000.pdf');
      const scan = page.locator('.pdf-page-scroll canvas');
      await expect(scan).toBeVisible();
      const pixel = await scan.evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
      ]);
      expect(pixel[1]).toBeGreaterThan(200);
      expect(pixel[0]).toBeLessThan(30);
      expect(pixel[2]).toBeLessThan(30);
      await open('broken.pdf');
      await expect(page.getByRole('alert')).toBeVisible();
      fs.copyFileSync(path.join(folder, 'document.pdf'), path.join(folder, 'broken.pdf'));
      await page.getByRole('button', { name: 'Retry file preview', exact: true }).click();
      await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
      for (const [name, expected] of [
        ['document.docx', 'Rendered Word document'],
        ['slides.pptx', 'Second preview slide'],
      ] as const) {
        await open(name);
        const frame = page.frameLocator('iframe[title="Document preview"]');
        await expect(frame.locator('body')).toContainText(expected);
        expect(await page.locator('iframe[title="Document preview"]').getAttribute('sandbox')).toBe('');
        expect(await frame.locator('body').evaluate(() => typeof (window as any).native)).toBe('undefined');
      }
      for (const name of ['book.xlsx', 'book.xls']) {
        await open(name);
        await expect(page.getByRole('table')).toContainText('First worksheet');
        await expect(page.getByRole('table')).toContainText('<script>cell()</script>');
        await page.getByLabel('Worksheet', { exact: true }).selectOption('1');
        await expect(page.getByRole('table')).toContainText('Second worksheet');
        await page.getByLabel('Worksheet', { exact: true }).selectOption('2');
        await expect(page.getByRole('table')).toContainText('Offset worksheet');
      }
      for (const name of ['legacy-word.doc', 'legacy.ppt']) {
        await open(name);
        await expect(page.locator('.file-legacy-preview')).toContainText('Text preview');
        await expect(page.locator('.file-legacy-preview pre')).not.toBeEmpty();
      }
      await open('table.csv');
      await expect(page.getByRole('table')).toContainText('Hello, world');
      await expect(page.getByRole('table')).toContainText('<script>unsafe()</script>');
      await page.getByRole('button', { name: 'View source', exact: true }).click();
      await expect(page.locator('.file-preview')).toContainText('Name,Value');
      await page.getByRole('button', { name: 'View rendered', exact: true }).click();
      await expect(page.getByRole('table')).toBeVisible();
      await open('table.tsv');
      await expect(page.getByRole('table')).toContainText('Tabbed');
      await open('page.html');
      const html = page.frameLocator('iframe[title="HTML preview"]');
      await expect(html.getByRole('heading', { name: 'Rendered local HTML' })).toBeVisible();
      // A click that reports success can still miss the button: a sandboxed frame's position is not part of Playwright's
      // actionability check, so a pane that is still settling under CI load moves the frame between the hit test and
      // the press (the frame never reloads and the button stays as it was). Click again until the page reacts.
      const clicked = html.getByRole('button', { name: 'Clicked' });
      await expect(async () => {
        if (!(await clicked.isVisible())) await html.getByRole('button', { name: 'Try interaction' }).click({ timeout: 2000 });
        await expect(clicked).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 15_000 });
      await expect(html.locator('body')).toHaveAttribute('data-bridge', 'undefined');
      for (const name of ['video.mp4', 'video.webm']) {
        await open(name);
        const video = page.getByLabel('Video preview', { exact: true });
        await expect(video).toBeVisible();
        await expect.poll(() => video.evaluate((el: HTMLVideoElement) => Number.isFinite(el.duration) && el.duration > 0)).toBe(true);
        await video.evaluate((el: HTMLVideoElement) => {
          el.currentTime = Math.min(0.2, el.duration / 2);
        });
        await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0);
      }
      await open('audio.wav');
      const audio = page.getByLabel('Audio preview', { exact: true });
      await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBe(1);
      const waveData = fs.readFileSync(path.join(folder, 'audio.wav')).toString('base64');
      const durations = await page.evaluate(async (base64) => {
        const blob = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'audio/wav' }));
        try {
          const durations: number[] = [];
          for (const src of [`data:audio/wav;base64,${base64}`, blob]) {
            const player = new Audio();
            try {
              durations.push(
                await new Promise<number>((resolve, reject) => {
                  player.onloadedmetadata = () => resolve(player.duration);
                  player.onerror = () => reject(new Error('Existing recording media source was blocked'));
                  player.src = src;
                  player.load();
                }),
              );
            } finally {
              player.pause();
              player.removeAttribute('src');
              player.load();
            }
          }
          return durations;
        } finally {
          URL.revokeObjectURL(blob);
        }
      }, waveData);
      expect(durations).toEqual([1, 1]);
      for (const name of ['image.bmp', 'image.avif']) {
        await open(name);
        const image = page.locator('.file-image-preview img');
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
      }
      await sendAppCommand(harness, 'toggle-files');
      await expect(page.locator('.files-tree')).toBeVisible();
      await page.locator('.files-tree').getByRole('button', { name: 'document.pdf', exact: true }).click();
      await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
      const bounds = await page.locator('.file-pdf-preview').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const p = el.parentElement!.getBoundingClientRect();
        return r.right <= p.right && r.width > 0 && r.height > 0;
      });
      expect(bounds).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('rich-preview-narrow.png') });
    });
  });
