// IPC for a project's environment config: the resolved source every window reads (env:resolve) and converting Conductor's to environment.toml (env:convert).
const path = require('node:path');
const { resolveEnvironment, convertToEnvironment } = require('../../platform/environmentSource.cjs');

const isRoot = (root) => typeof root === 'string' && path.isAbsolute(root);

/** @param {import('electron').IpcMain} ipcMain */
function register(ipcMain) {
  // the same resolver main's own chat starts use (platform/chatStart.cjs), so a window never reads another answer
  ipcMain.handle('env:resolve', (_e, root) => {
    if (!isRoot(root)) throw new Error('invalid');
    return resolveEnvironment(root);
  });
  ipcMain.handle('env:convert', (_e, root) => (isRoot(root) ? convertToEnvironment(root) : { ok: false, error: 'invalid' }));
}

module.exports = { register };
