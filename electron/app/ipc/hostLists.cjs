// The lists the windows read of the machines: the machines themselves and each one's chats (electron/host/chatIndex.cjs); both are empty while Host access is closed.
const NONE = Object.freeze({ machines: [], resolved: true });

/** @param {{ ipcMain: { handle: (channel: string, fn: (...a: any[]) => unknown) => void }, allowed: () => boolean, service: () => { list: () => unknown, chatIndex: () => unknown } }} o */
function registerHostLists({ ipcMain, allowed, service }) {
  ipcMain.handle('host:machines', () => (allowed() ? service().list() : NONE));
  ipcMain.handle('host:chatIndex', () => (allowed() ? service().chatIndex() : []));
}

module.exports = { registerHostLists, registeredBy: 'host' };
