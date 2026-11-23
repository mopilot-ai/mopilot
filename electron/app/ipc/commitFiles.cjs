// IPC for the Changes pane's commit (git:commitFiles): every change, or only the ticked files, built in main in an index of its own (platform/commitFiles.cjs).
const { commitFiles } = require('../../platform/commitFiles.cjs');

/** @param {import('electron').IpcMain} ipcMain */
function register(ipcMain) {
  ipcMain.handle('git:commitFiles', (_e, root, message, files) => commitFiles(root, message, files));
}

module.exports = { register };
