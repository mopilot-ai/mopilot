// The built-in browser's memory guard as main runs it: over BrowserWindows' pages, never an app window, from the browser's start to quit, with a release's smoke launch told whether it can stop pages.
const { MemoryGuard } = require('../capabilities/browser/memoryGuard.cjs');
const { currentSmokeLaunch } = require('./smokeLaunch.cjs');

/**
 * A page that floods main's memory has its renderer stopped before the whole app runs out (every harness, every partition).
 * @param {{ app: Pick<Electron.App, 'on'>, browserWindows: InstanceType<typeof import('../capabilities/browser/windows.cjs').BrowserWindows>, windows: Set<Electron.BrowserWindow> }} o
 */
function startMemoryGuard({ app, browserWindows, windows }) {
  const memoryGuard = new MemoryGuard({
    pages: () => [...browserWindows.pages.values()].map((p) => p.wc),
    appContents: () => [...windows].filter((w) => !w.isDestroyed()).map((w) => w.webContents),
    onStopped: (wc) => browserWindows.stoppedForMemory(wc),
    onReady: (problem) => currentSmokeLaunch()?.memoryGuard(problem),
  });
  memoryGuard.start();
  app.on('will-quit', () => memoryGuard.stop());
}

module.exports = { startMemoryGuard };
