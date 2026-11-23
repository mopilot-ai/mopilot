// Persisted turn snapshots reveal generated visual files, retain previews on refresh failure and populate Outputs/Usage.
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/OutputsPanel.tsx src/components/panels/UsagePanel.tsx
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { writePreviewFiles } from '../fixtures/previewFiles';
import { shootBoth, SYSTEM_THEME } from './fixtures/shoot';

async function openSessionPanel(page: Page, action: 'Outputs' | 'Usage') {
  await page.locator('.summary-panel').getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

for (const family of ['codex', 'claude'] as const)
  test.describe(`Session outputs on ${family}`, () => {
    test.use({ harnesses: family, seed: { uiState: { summaryOpen: true, prefs: { ...SYSTEM_THEME.prefs, fontSize: 24, zoomLevel: 0 } } } });
    test('reveals written previews, recovers a failed refresh and reopens outputs from history', async ({ page, harness }) => {
      test.setTimeout(150_000);
      const repo = path.join(harness.dir, 'home', 'generated-output');
      const input = path.join(harness.dir, 'preview-input');
      await writePreviewFiles(input);
      fs.mkdirSync(repo, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'e2e');
      git('config', 'user.email', 'e2e@example.com');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Generated output project');
      git('add', '.');
      git('commit', '-qm', 'Initial');
      await harness.app.evaluate(({ dialog }, repo) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [repo] })) as any;
      }, repo);
      await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('warm up');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.assistant-message').filter({ hasText: `fake-${family}: warm up` })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await openSessionPanel(page, 'Outputs');
      await expect(page.getByRole('region', { name: 'Session outputs' })).toContainText('No outputs in the loaded part');
      await page.getByRole('button', { name: 'Hide tabs', exact: true }).click();
      for (const name of ['page.html', 'image.bmp', 'document.pdf', 'video.webm']) {
        // The fake command's filesystem side effect is captured by the real main-process turn snapshot, just as a shell write is.
        await composer.fill(`SLOW produce ${name}`);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
        await expect(page.locator('.assistant-message').filter({ hasText: `fake-${family}: SLOW produce ${name}` })).toBeVisible();
        fs.copyFileSync(path.join(input, name), path.join(repo, name));
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await expect(page.locator('.side-pane .file-preview-head')).toContainText(name);
        const visible = page.locator('.preview-generation:not([hidden])');
        if (name.endsWith('.html')) await expect(visible.locator('iframe')).toBeVisible();
        if (name.endsWith('.bmp'))
          await expect.poll(() => visible.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
        if (name.endsWith('.pdf')) await expect(visible.locator('canvas')).toBeVisible();
        if (name.endsWith('.webm'))
          await expect.poll(() => visible.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(1);
      }
      await page.getByRole('button', { name: 'image.bmp', exact: true }).click();
      const image = page.locator('.preview-generation:not([hidden]) img');
      await expect(image).toBeVisible();
      fs.writeFileSync(path.join(repo, 'image.bmp'), 'broken image');
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      await expect(page.locator('.preview-error')).toContainText('last readable version');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      fs.copyFileSync(path.join(input, 'image.bmp'), path.join(repo, 'image.bmp'));
      await page.getByRole('button', { name: 'Retry file preview', exact: true }).filter({ visible: true }).click();
      await expect(page.locator('.preview-error')).toHaveCount(0);
      await expect(page.locator('.preview-generation img')).toHaveCount(1);
      await page.getByRole('button', { name: 'Hide tabs', exact: true }).click();
      await openSessionPanel(page, 'Outputs');
      const outputs = page.getByRole('region', { name: 'Session outputs' });
      await expect(outputs).toContainText('4 outputs');
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 682 });
        await shootBoth(page, harness.app, `session-outputs-${width}`);
      }
      await outputs.getByRole('button', { name: 'document.pdf', exact: true }).click();
      await expect(page.locator('.preview-generation:not([hidden]) canvas')).toBeVisible();
      await page.getByRole('button', { name: 'Hide tabs', exact: true }).click();
      await openSessionPanel(page, 'Usage');
      await expect(page.getByRole('region', { name: 'Session usage' })).toContainText('CostNot reported');
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 682 });
        await shootBoth(page, harness.app, `session-usage-${width}`);
      }
    });
    test('opens a generated absolute output from a chat started without choosing a project', async ({ page }) => {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('EDITFILE projectless');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page
        .locator('.approval-card')
        .getByRole('button', { name: /Allow once/ })
        .click();
      await expect(page.getByRole('main').getByText(`fake-${family}: EDITFILE projectless [edit: written]`, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await openSessionPanel(page, 'Outputs');
      const outputs = page.getByRole('region', { name: 'Session outputs' });
      await outputs.getByRole('button', { name: 'hello.txt', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Edit hello.txt', exact: true })).toHaveValue('hello\nworld\n');
    });
  });
