// An app window whose renderer is gone comes back on its own instead of staying blank (#4424): the crashed page reloads in a new renderer and finishes loading the app again.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('app window recovery: a crashed renderer reloads and the app loads again', async ({ harness, page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();

  // what users saw as a white window: the main window's renderer killed (memory pressure, a crash). What follows is read
  // in main, from the window's own events: Playwright stops driving a page whose renderer crashed, so the page can't be asked.
  const crashed = await harness.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => /\/dist\/index\.html(#|$)/.test(w.webContents.getURL()) && !w.webContents.getURL().includes('#mini'),
    )!;
    const wc = win.webContents;
    const seen: string[] = [];
    (globalThis as any).__recovery = { wc, seen, pid: wc.getOSProcessId() };
    wc.on('render-process-gone', (_e, d) => seen.push(`gone:${d.reason}`));
    wc.on('did-start-loading', () => seen.push('start'));
    wc.on('did-finish-load', () => seen.push('finish'));
    wc.forcefullyCrashRenderer();
    return (globalThis as any).__recovery.pid as number;
  });

  // the window reloads by itself, in a new renderer, and its page finishes loading (its scripts ran: not a blank window)
  await expect
    .poll(() => harness.app.evaluate(() => (globalThis as any).__recovery.seen.join(' ')), { timeout: 30_000 })
    // recovery's own listener came first and reloaded synchronously, so its 'start' can precede this listener's 'gone'
    .toMatch(/^(gone:\w+ start|start gone:\w+)( start)* finish$/);
  const after = await harness.app.evaluate(async () => {
    const r = (globalThis as any).__recovery;
    const text = await Promise.race([
      r.wc.executeJavaScript('document.body.innerText').catch((e: Error) => `error: ${e.message}`),
      new Promise((resolve) => setTimeout(() => resolve('no answer in 5 s'), 5_000)),
    ]);
    return { crashed: r.wc.isCrashed(), pid: r.wc.getOSProcessId(), url: r.wc.getURL(), text: String(text).slice(0, 200) };
  });
  console.log('[recovery]', JSON.stringify(after));
  expect(after.crashed).toBe(false);
  expect(after.pid).not.toBe(crashed);
  expect(after.url).toMatch(/\/dist\/index\.html/);

  // and the problem is kept for Copy diagnostics, the window named
  const problems = await harness.app.evaluate(
    (_e, file) => (process as any).mainModule?.require(file).recentWindowProblems(),
    path.resolve('electron/platform/windowRecovery.cjs'),
  );
  expect(problems.at(-1)).toMatchObject({ window: 'app window' });
  expect(problems.at(-1).problem).toMatch(/^renderer gone: /);
});
