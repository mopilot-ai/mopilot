// Main-window visibility before the first renderer navigation, including automatic-update window restoration.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a minimized window needs a window manager, which the Linux runner’s virtual display has none of');

test.use({ mainRequire: [path.resolve(__dirname, 'fixtures/window-launch-hook.cjs')] });

for (const [name, window] of [
  ['ordinary launch', undefined],
  ['visible automatic-update restart', { visible: true, minimized: false }],
  ['minimized automatic-update restart', { visible: false, minimized: true }],
  ['hidden automatic-update restart', { visible: false, minimized: false }],
] as const) {
  test.describe(name, () => {
    test.use({
      seed: {
        files: ({ userData }) => {
          if (window) fs.writeFileSync(path.join(userData, 'restart-view.json'), JSON.stringify({ ts: Date.now(), window }));
        },
      },
    });

    test('presents the native window before the renderer can paint', async ({ harness, page }) => {
      const first = JSON.parse(fs.readFileSync(path.join(harness.env.MOPILOT_USER_DATA, 'window-before-navigation.json'), 'utf8'));
      expect(first).toMatchObject({
        visible: window ? window.visible : true,
        minimizeRequested: window?.minimized ?? false,
        focused: false,
        url: '',
      });
      console.log(`${name}: native visibility established before navigation (${first.elapsedMs.toFixed(1)}ms)`);
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      // macOS completes minimization asynchronously: its request precedes navigation, its state settles afterward.
      await expect
        .poll(() =>
          harness.app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'))!;
            return { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() };
          }),
        )
        .toEqual({ visible: window ? window.visible : true, minimized: window?.minimized ?? false, focused: false });
      expect(fs.existsSync(path.join(harness.env.MOPILOT_USER_DATA, 'restart-view.json'))).toBe(false);
    });
  });
}
