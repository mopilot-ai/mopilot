// IPC for context snapshots (electron/context): a chat owner's snapshot, and a fresh read of it (Claude Code's breakdown, summary or full).
const { appContext } = require('../../context/index.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {unknown} _deps
 * @param {() => ReturnType<typeof appContext>} [context]
 */
function register(ipcMain, _deps, context = appContext) {
  ipcMain.handle('context:get', (_e, owner) => context()?.service.get(String(owner)) ?? null);
  ipcMain.handle(
    'context:refresh',
    (_e, owner, detail) => context()?.service.refresh(String(owner), detail === 'full' ? 'full' : 'summary') ?? null,
  );
}

module.exports = { register };
