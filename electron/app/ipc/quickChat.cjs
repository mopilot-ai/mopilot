// IPC for the Quick Chat window: readiness, its saved state, and opening a chat or Settings in the main window.

const { isQuickChatSender } = require('../../session/quickChat.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const { windows, windowReadiness, readyMainWindow, live } = deps;
  const requireQuickChat = (e) => {
    if (!isQuickChatSender(live.mini, e.sender)) throw new Error('Invalid Quick Chat sender');
  };
  ipcMain.on('window:ready', (e) => {
    if ([...windows].some((w) => !w.isDestroyed() && w.webContents === e.sender)) windowReadiness.mark(e.sender.id);
  });
  ipcMain.handle('quick-chat:read', (e) => {
    requireQuickChat(e);
    return live.quickState.read();
  });
  ipcMain.handle('quick-chat:save', (e, state) => {
    requireQuickChat(e);
    const owned = live.quickState.read().threadId;
    // the chat Quick Chat speaks for changed: its messages view asks again (it may have asked before the chat was saved)
    if (live.quickState.save(state).threadId !== owned) e.sender.send('peer:changed');
  });
  ipcMain.handle('quick-chat:open', async (e, id) => {
    try {
      requireQuickChat(e);
      if (!live.quickState.owns(id)) throw new Error('This chat is no longer available');
      const w = await readyMainWindow();
      requireQuickChat(e);
      if (!live.quickState.owns(id)) throw new Error('This chat is no longer available');
      w.webContents.send('app:command', 'open-chat', id);
      w.show();
      w.focus();
      live.mini?.hide();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
  ipcMain.handle('quick-chat:settings', async (e, section) => {
    try {
      requireQuickChat(e);
      const w = await readyMainWindow();
      requireQuickChat(e);
      w.webContents.send('app:command', 'settings', typeof section === 'string' ? section : undefined);
      w.show();
      w.focus();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
  ipcMain.handle('mini:hide', () => live.mini && !live.mini.isDestroyed() && live.mini.hide());
}

module.exports = { register };
