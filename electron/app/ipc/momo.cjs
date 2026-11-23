// IPC for MoMo's closed-alpha gate: the windows ask whether MoMo exists for this account; changes reach them as momo:access (electron/app/identity.cjs).
const { momoAllowed } = require('../../momo/access.cjs');

/** @param {import('electron').IpcMain} ipcMain */
function register(ipcMain) {
  ipcMain.handle('momo:access', () => momoAllowed());
}

module.exports = { register };
