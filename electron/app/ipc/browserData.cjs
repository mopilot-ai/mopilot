// IPC for what the built-in browser remembers (history, bookmarks): the address bar's suggestions and the bookmark star and menu.
const { prefixCodePoints } = require('../../../shared/textPrefix.mjs');
const MAX_TEXT = 300;
const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? prefixCodePoints(v, max) : '');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ data: ReturnType<typeof import('../../capabilities/browser/data.cjs').createBrowserData>, broadcastAll: (channel: string, payload?: any) => void }} deps
 */
function register(ipcMain, { data, broadcastAll }) {
  ipcMain.handle('browser:suggest', (_e, typed) => data.suggest(text(typed, 200)));
  ipcMain.handle('browser:removeHistory', (_e, url) => data.history().remove(text(url, 4096)));
  ipcMain.handle('browser:bookmarks', () => data.bookmarks().list());
  ipcMain.handle('browser:bookmarked', (_e, url) => data.bookmarks().find(text(url, 4096)).length > 0);
  ipcMain.handle('browser:toggleBookmark', (_e, req) => {
    const out = data.bookmarks().toggle({ url: text(req?.url, 4096), title: text(req?.title) });
    if (out.ok) broadcastAll('browser:bookmarksChanged');
    return out;
  });
  ipcMain.handle('browser:removeBookmark', (_e, id) => {
    const removed = data.bookmarks().remove(text(id, 100));
    if (removed) broadcastAll('browser:bookmarksChanged');
    return removed;
  });
}

module.exports = { register, registeredBy: 'browser' };
