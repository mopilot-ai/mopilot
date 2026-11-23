// claude:desktopLineage: which chats a Claude desktop chat started, for the sidebar's nesting (harness/claude/desktopLineage.cjs).
const { createDesktopLineage } = require('../../harness/claude/desktopLineage.cjs');
const { claudeAppData } = require('../../platform/nativeSchedulers.cjs');

/** One reader serves every window, so a file unchanged since the last read is not parsed again. */
function register(ipcMain, _deps, lineage = createDesktopLineage({ appData: () => claudeAppData() })) {
  ipcMain.handle('claude:desktopLineage', () => lineage.read());
}

module.exports = { register };
