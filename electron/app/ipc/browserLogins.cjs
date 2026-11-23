// IPC for the browser pane's key button and "Save password?" bar: the saved logins of the page's site (user names only), filling one into the page (pane tabs only), and the user's answer to an offer to save a password (loginAssist.cjs).
const { originOf } = require('../../capabilities/browser/origins.cjs');
const { fillLogin } = require('../../capabilities/browser/userFill.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ store: () => any, assist: () => { answer(id: number, choice: string, offerId: string): string }, webContents: { fromId(id: number): any }, panelSessions: () => any[], confirm: (host: string) => Promise<boolean> }} deps
 *   store: MoPilot's own login store
 *   assist: the in-page login help, which holds a page's offer to save a password
 *   panelSessions: the sessions browser pane tabs live in (an app window is never filled)
 *   confirm: asks the user (Touch ID) before a password is used
 */
function register(ipcMain, { store, assist, webContents, panelSessions, confirm }) {
  ipcMain.handle('browser:logins', (_e, url) => {
    const origin = originOf(typeof url === 'string' ? url : '');
    return origin ? store().list(origin) : [];
  });
  ipcMain.handle('browser:fillLogin', async (_e, webContentsId, id) => {
    const wc = typeof webContentsId === 'number' ? webContents.fromId(webContentsId) : null;
    if (!wc || wc.isDestroyed() || !panelSessions().includes(wc.session)) return 'not_found';
    return fillLogin({ wc, store: store(), id: String(id ?? ''), confirm });
  });
  // the password stays in main: the pane only says which page's offer and what the user chose
  ipcMain.handle('browser:answerLoginOffer', (_e, webContentsId, choice, offerId) =>
    typeof webContentsId === 'number' ? assist().answer(webContentsId, String(choice), String(offerId)) : 'gone',
  );
}

module.exports = { register, registeredBy: 'browser' };
