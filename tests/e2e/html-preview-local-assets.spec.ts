// An HTML file previewed in the side pane shows with the stylesheet and images beside it, and picks up a stylesheet edit.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures/app';

// a 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.use({ harnesses: 'claude' });
test('a design page renders its sibling stylesheet and image instead of black SVG boxes', async ({ page, harness }) => {
  test.setTimeout(90_000);
  const folder = path.join(harness.dir, 'home', 'design');
  fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'styles.css'), 'svg .box { fill: rgb(10, 120, 200); }\nh1 { color: rgb(0, 128, 0); }\n');
  fs.writeFileSync(path.join(folder, 'assets', 'dot.png'), Buffer.from(PNG, 'base64'));
  fs.writeFileSync(
    path.join(folder, 'connectors.html'),
    '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Connectors</h1>' +
      '<svg width="200" height="80"><rect class="box" x="0" y="0" width="200" height="80"/></svg><img alt="dot" src="assets/dot.png"></body></html>',
  );
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await harness.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, folder);
  await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill(`[connectors.html](${pathToFileURL(path.join(folder, 'connectors.html')).href})`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const link = page.locator('.assistant-message').getByRole('link', { name: 'connectors.html', exact: true });
  await expect(link).toBeVisible();
  await link.click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  const fill = () => frame.locator('rect.box').evaluate((el) => getComputedStyle(el).fill);
  await expect.poll(fill).toBe('rgb(10, 120, 200)');
  await expect(frame.getByRole('heading', { name: 'Connectors' })).toHaveCSS('color', 'rgb(0, 128, 0)');
  await expect.poll(() => frame.getByRole('img', { name: 'dot' }).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  // an edit to the stylesheet alone shows on the next read of the page
  fs.writeFileSync(path.join(folder, 'styles.css'), 'svg .box { fill: rgb(200, 30, 30); }\n');
  await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect.poll(fill, { timeout: 15_000 }).toBe('rgb(200, 30, 30)');
});
