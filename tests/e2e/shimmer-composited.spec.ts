// A working chat's shimmering sidebar title keeps sweeping while the renderer's main thread is busy: the band is a
// composited translate, so frames captured during a long main-thread task still show it moving (a background-position
// sweep froze there, which is what made it look choppy while a turn streamed).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

/** The label's pixels from the window's compositor frame, captured by main (works while the page's main thread is blocked). */
async function frame(h: Harness, rect: { x: number; y: number; width: number; height: number }) {
  const png = await h.app.evaluate(async ({ BrowserWindow }, r) => {
    const win =
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')) ?? BrowserWindow.getAllWindows()[0];
    return (await win.webContents.capturePage(r)).toPNG().toString('base64');
  }, rect);
  return png;
}

test('a working chat title keeps shimmering while the main thread is busy', async ({ page, harness }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await composer(page).fill('SLOW shimmer check');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  const title = page.getByRole('complementary').locator('.thread-row .side-row-label .shimmer-text').first();
  // the generated title replaces the first words with a crossfade; measure the settled one
  await expect(title).toHaveText('Fake chat title');
  await expect(page.getByRole('complementary').locator('.morph-out')).toHaveCount(0);
  const box = (await title.boundingBox())!;
  const rect = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
  /** Keeps a frame next to the run's other output, for a look at the band over the words. */
  const keep = (name: string, png: string) => fs.writeFileSync(testInfo.outputPath(`${name}.png`), Buffer.from(png, 'base64'));
  keep('title', await frame(harness, rect));
  const row = (await page.getByRole('complementary').locator('.thread-row:has(.shimmer-text)').first().boundingBox())!;
  keep(
    'row',
    await frame(harness, { x: Math.floor(row.x), y: Math.floor(row.y), width: Math.ceil(row.width), height: Math.ceil(row.height) }),
  );

  // hold the renderer's main thread for 2.4s (most of a 3s sweep) and sample the title from main meanwhile
  const busy = page.evaluate(() => {
    const end = performance.now() + 2400;
    while (performance.now() < end);
  });
  await new Promise((r) => setTimeout(r, 150));
  const shots: string[] = [];
  const started = Date.now();
  while (Date.now() - started < 2000) {
    shots.push(await frame(harness, rect));
    await new Promise((r) => setTimeout(r, 120));
  }
  await busy;
  const distinct = new Set(shots.map((s) => createHash('sha1').update(s).digest('hex'))).size;
  console.log(`@@ ${shots.length} frames during the blocked main thread, ${distinct} distinct`);
  for (const [i, s] of shots.entries()) keep(`blocked-${i}`, s);
  expect(distinct, 'the band moves while the main thread is blocked').toBeGreaterThanOrEqual(3);
});
