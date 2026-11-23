// Regressions found by testing the app: Enter on a focused Deny denies; the main window never loads a
// page other than the app's own, so a dropped or linked file can't reach the preload bridge; a new chat's
// starting bubble shows a pasted image as its picture.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.approval-card');
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({ harnesses: 'both' });

test('Enter on a focused Deny denies; Enter elsewhere still approves', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'APPROVECMD first');
  await expect(card(page)).toContainText('Allow Codex to run this command?');
  await card(page).locator('.ap-btn.deny').focus();
  await page.keyboard.press('Enter');
  await expect(transcript(page).getByText(/fake-codex: APPROVECMD first \[command: declined\]/)).toBeVisible();

  await send(page, 'APPROVECMD second');
  await expect(card(page)).toContainText('Allow Codex to run this command?');
  await page.locator('body').focus();
  await page.keyboard.press('Enter');
  await expect(transcript(page).getByText(/fake-codex: APPROVECMD second \[command: ran\]/)).toBeVisible();
});

test('the main window does not navigate to a local file', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  const f = `${harness.dir}/dropped.html`;
  fs.writeFileSync(f, '<html><body><h1 id="dropped">dropped page</h1></body></html>');
  await page.evaluate((u) => setTimeout(() => (location.href = u), 0), `file://${f}`);
  // read from main: the renderer's own view of a cancelled navigation keeps Playwright waiting
  const url = () => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
  await page.waitForTimeout(1500);
  const urls = await url();
  expect(urls.some((u) => u.includes('dropped.html'))).toBe(false);
  expect(urls.some((u) => u.endsWith('dist/index.html') || u.includes('dist/index.html#'))).toBe(true);
});

test('a pasted image of any type is saved, each paste to its own file', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const saved = await page.evaluate(([a, b]) => Promise.all([a, a, b].map((u) => (window as any).native.fs.saveTempImage(u))), [svg, png]);
  expect(saved[0]).toMatch(/\.svg$/);
  expect(saved[1]).toMatch(/\.svg$/);
  expect(saved[2]).toMatch(/\.png$/);
  expect(new Set(saved).size).toBe(3);
});

test('a new chat sent with a pasted image shows the picture while it starts, never a "Pasted image" chip', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  // a 1x1 PNG pasted into the composer, as the clipboard hands it over
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  await composer(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(page.locator('.attachment img')).toHaveCount(1);
  // what the starting bubble draws, recorded as it happens: the start can be quicker than a poll
  await page.evaluate(() => {
    const seen = ((window as any).__starting = { images: 0, chips: [] as string[] });
    new MutationObserver(() => {
      const bubble = document.querySelector('.new-chat-starting .user-message');
      if (!bubble) return;
      seen.images = Math.max(seen.images, bubble.querySelectorAll('.user-images.pending img[src^="data:image/png"]').length);
      for (const c of bubble.querySelectorAll('.mention-chip')) seen.chips.push(c.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await send(page, 'what is this picture');
  await expect(transcript(page).getByText('fake-codex: what is this picture', { exact: true })).toBeVisible();
  const seen = await page.evaluate(() => (window as any).__starting);
  expect(seen).toEqual({ images: 1, chips: [] });
  // the sent message keeps the picture, and opens it
  const sent = transcript(page).locator('.user-message .user-images img');
  await expect(sent).toHaveCount(1);
  await expect(sent).toHaveAttribute('role', 'button');
  await expect(transcript(page).getByText('Pasted image')).toHaveCount(0);
});

test("the threads MoPilot starts itself (the probe, a chat's title) have native control off and no sage-mcp", async ({ page, harness }) => {
  // a chat's own thread gets sage-mcp, which builds only on macOS; the PR check runs this spec on its macOS runner
  test.skip(process.platform !== 'darwin', 'compares against the sage-mcp a chat thread gets, which builds only on macOS');
  await expect(home(page)).toBeVisible();
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-codex: hello', { exact: true })).toBeVisible();
  await expect
    .poll(() => harness.codexLog().filter((e) => e.method === 'thread/start' && e.params?.ephemeral).length)
    .toBeGreaterThanOrEqual(2);
  const starts = harness.codexLog().filter((e) => e.method === 'thread/start');
  for (const s of starts) expect(s.params.config.plugins['unified-computer-use@openai-bundled']).toEqual({ enabled: false });
  const sage = (s: any) => Object.keys(s.params.config.mcp_servers ?? {}).some((n) => n.startsWith('sage_'));
  expect(starts.filter((s) => s.params.ephemeral).some(sage)).toBe(false);
  expect(starts.filter((s) => !s.params.ephemeral).every(sage)).toBe(true);
});

test('a link in a chat gets a letter mark drawn locally, with no request to a favicon service', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  await expect(home(page)).toBeVisible();
  await send(page, 'see [the docs](https://example.com/x)');
  const link = transcript(page).locator('.md a', { hasText: 'the docs' }).last();
  await expect(link).toBeVisible();
  await expect(link.locator('.md-favicon')).toHaveAttribute('data-letter', 'E');
  // the letter is not text: copying or reading the message gives the link text only
  expect(await link.evaluate((a) => (a as HTMLElement).innerText.trim())).toBe('the docs');
  await expect(link.locator('img')).toHaveCount(0);
  expect(asked.filter((u) => /google\.com|example\.com/.test(u))).toEqual([]);
});
