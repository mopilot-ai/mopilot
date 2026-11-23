// IPC for the composer's errand strip: the sites where a chat's ordinary messages are allowed for its errand, in either browser
// (errandGrants.cjs), Revoke on one, and a push whenever a chat's list changes.
const { onErrandsChanged } = require('../../capabilities/browser/errandGrants.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ live: { browserGrants?: any, chromeGrants?: any }, broadcastAll: (channel: string, payload: unknown) => void }} deps
 *   live: holds each browser's site table once the browser tools start
 */
function register(ipcMain, { live, broadcastAll }) {
  const tables = () => [live.browserGrants, live.chromeGrants].filter(Boolean);
  const list = (/** @type {string} */ chatId) => tables().flatMap((g) => g.errands.list(chatId));
  ipcMain.handle('browser:errands', (_e, chatId) => list(String(chatId)));
  ipcMain.handle('browser:revokeErrand', (_e, chatId, site, browser) => {
    const table = browser === 'chrome' ? live.chromeGrants : live.browserGrants;
    return table?.errands.revoke(String(chatId), String(site)) ?? false;
  });
  return onErrandsChanged((_browser, chatId) => broadcastAll('browser:errandsChanged', { chatId, errands: list(chatId) }));
}

module.exports = { register, registeredBy: 'browser' };
