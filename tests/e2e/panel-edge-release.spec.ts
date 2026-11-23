// A side pane edge released over what the pane embeds stops following the mouse (#3833), and still drags afterwards.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { sizeRealWindow } from './fixtures/window';
import { pickScope } from './fixtures/approvalScope';

test.use({ harnesses: 'claude' });

/**
 * Room for the pane to grow. The window opens at what the display holds: on the Windows runner (a 1024x768 display) that
 * is 1024 wide, where the pane is already at its widest (392 px beside the chat's minimum), so the last drag had nowhere
 * to go (win-e2e runs 43610383130, 43608770138). There the real window is sized as wide as on the other runners'
 * displays; a window may be larger than the display.
 */
async function roomToGrow(page: Page, harness: Harness) {
  if (process.platform === 'win32') await sizeRealWindow(page, harness, 1440, 900);
}

const paneWidth = (page: Page) => page.locator('.side-pane').evaluate((el) => Math.round(el.getBoundingClientRect().width));
const afterFrames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Presses the pane's edge, releases over `over`, comes back with no button held, then drags the edge once more. */
async function releaseOverEmbeddedContent(page: Page, content: Locator) {
  // Equal rounded samples can occur while the spring still runs. Measure both surfaces after it finishes.
  await expect.poll(() => page.locator('.side-pane').evaluate((el) => el.getAnimations().length)).toBe(0);
  const box = (await content.boundingBox())!;
  const over = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const edge = (await page.locator('.pane-resize').boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.locator('html')).toHaveAttribute('data-edge-drag', 'column');
  await page.mouse.move(over.x, over.y, { steps: 8 });
  await page.mouse.up();
  await afterFrames(page);
  const settled = await paneWidth(page);

  // the original report: no button held, and the edge came along
  await page.mouse.move(x - 120, y, { steps: 4 });
  await afterFrames(page);
  await page.mouse.move(x - 60, y, { steps: 4 });
  await page.mouse.move(x - 180, y, { steps: 4 });
  await afterFrames(page);
  expect(await paneWidth(page), 'the width stays while no button is held').toBe(settled);
  await expect(page.locator('html')).not.toHaveAttribute('data-edge-drag');

  // the edge still works, from wherever it was left
  const again = (await page.locator('.pane-resize').boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(again.x + again.width / 2 - 40, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => paneWidth(page)).toBe(settled + 40);
}

test('released over an HTML preview, the edge stops following the mouse', async ({ page, harness }) => {
  test.setTimeout(90_000);
  const folder = path.join(harness.dir, 'home', 'design');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), '<!DOCTYPE html><html><body><h1>Preview</h1></body></html>');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await roomToGrow(page, harness);
  await harness.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, folder);
  await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill(`[index.html](${pathToFileURL(path.join(folder, 'index.html')).href})`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.assistant-message').getByRole('link', { name: 'index.html', exact: true }).click();
  const frame = page.locator('iframe[title="HTML preview"]');
  await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading', { name: 'Preview' })).toBeVisible();
  await releaseOverEmbeddedContent(page, frame);
});

test('released over a browser tab, the edge stops following the mouse', async ({ page, harness }) => {
  test.setTimeout(90_000);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Fixture</title><h1>Fixture page</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await roomToGrow(page, harness);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`CUCALL mcp__mopilot_browser__navigate ${JSON.stringify({ url: site })}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const approval = page.locator('.sage-approval');
    await expect(approval).toContainText(site);
    await pickScope(approval, /Allow in this chat/);
    const stage = page.locator('.browser-stage');
    await expect(stage).toBeVisible();
    await releaseOverEmbeddedContent(page, stage);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
