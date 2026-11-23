// #3977: SIGTERM ends the app within the quit deadline although a window will not close (a native sheet on it, which does not close until answered).
import { test, expect } from './fixtures/app';

// Windows has no SIGTERM to handle: process.kill ends a process there at once (Node's process.kill), so the app's
// signal deadline (electron/platform/exitGate.cjs) is a macOS and Linux one
test.skip(process.platform === 'win32', 'Windows has no SIGTERM: process.kill ends the app at once, with no handler to run');

test('SIGTERM ends the app although the window refuses to close', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await harness.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.on('close', (e) => e.preventDefault());
  });
  const closed = harness.app.waitForEvent('close');
  const started = Date.now();
  process.kill(harness.app.process().pid!, 'SIGTERM');
  await closed;
  expect(Date.now() - started).toBeLessThan(25_000);
});
