// A side pane edge drag ends when the press is released inside an embedded frame, which never tells the app window (#3833).
import { test, expect } from './fixtures/app';
import { sizeViewport } from './fixtures/window';

const CHAT = '019c0000-0000-7000-8000-000000003833';

test.use({
  harnesses: 'codex',
  seed: { codexThreads: [{ id: CHAT, name: 'A', turns: ['Ready'] }] },
});

test('the pane edge stops following the mouse once the press was released over an iframe', async ({ page, harness }) => {
  await sizeViewport(page, harness, 1280, 800);
  await page.locator(`[data-sidebar-chat="${CHAT}"]`).click();
  await page.locator('.titlebar-right button[aria-label="New tab"]').click();
  const pane = page.locator('.side-pane');
  const handle = page.locator('.pane-resize');
  await expect(handle).toBeVisible();
  // Measure the edge after its opening spring, including any retargeted animation, has finished.
  await expect.poll(() => pane.evaluate((el) => el.getAnimations().length)).toBe(0);
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // a frame over the chat column stands in for the HTML preview the pane edge crosses
  await page.evaluate((right) => {
    const frame = document.createElement('iframe');
    frame.id = 'probe-frame';
    frame.srcdoc = '<body style="background:#fdd"></body>';
    frame.style.cssText = `position:fixed;left:0;top:0;width:${right}px;height:100%;z-index:99999;border:0`;
    document.body.appendChild(frame);
  }, x - 80); // the first 60-pixel held move stays outside the frame, so it must exercise the admitted drag
  const width = async () => (await pane.boundingBox())!.width;
  const start = await width();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.locator('html')).toHaveAttribute('data-edge-drag', 'column');
  await page.mouse.move(x - 60, y, { steps: 6 });
  await expect.poll(width).toBeGreaterThan(start + 40);
  // over the frame: its document, not the app window, gets the release
  const frame = (await page.locator('#probe-frame').boundingBox())!;
  await page.mouse.move(frame.x + frame.width / 2, y, { steps: 6 });
  await page.mouse.up();
  await page.evaluate(() => document.getElementById('probe-frame')!.remove());
  // The app learns about the release on its first buttonless move and flushes the last held move, even if its
  // animation frame was still pending. Compare later moves with that committed width, not the prior painted frame.
  await page.mouse.move(110, y);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const stopped = await width();
  // back over the app with no button held
  await page.mouse.move(box.x - 300, y, { steps: 6 });
  await page.mouse.move(box.x + 100, y, { steps: 6 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // a pane still following the mouse would be hundreds of pixels away
  expect(Math.abs((await width()) - stopped)).toBeLessThan(2);
  await expect(page.locator('html')).not.toHaveAttribute('data-edge-drag');
});
