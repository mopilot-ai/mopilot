// IPC for Linear (electron/platform/linearSource.cjs): connecting with the user's own API key, kept encrypted in main, and reading an issue to start a chat from; the branch picker's lookup reaches it through startSource.cjs.
const path = require('node:path');
const { createLinear } = require('../../platform/linearSource.cjs');
const { setLinear } = require('../../platform/startSource.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ app: { getPath(name: string): string } }} deps
 * @param {{ safeStorage?: any, fetch?: any }} [o] for tests
 */
function register(ipcMain, { app }, { safeStorage, fetch } = {}) {
  const linear = createLinear({
    dir: path.join(app.getPath('userData'), 'linear'),
    safe: safeStorage ?? require('electron').safeStorage,
    ...(fetch ? { fetch } : {}),
  });
  setLinear(linear);
  ipcMain.handle('linear:status', () => linear.status());
  ipcMain.handle('linear:connect', (_e, apiKey) => linear.connect(apiKey));
  ipcMain.handle('linear:disconnect', () => linear.disconnect());
  ipcMain.handle('linear:issue', (_e, key) => linear.find(key, { withText: true }));
}

module.exports = { register };
