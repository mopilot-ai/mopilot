// IPC for the session rail's Servers section: a chat's dev-preview servers (electron/capabilities/browser/devPreview), stopping
// one, and previews:changed to the windows when one starts, becomes ready, exits or is stopped (by the rail or an agent). The window opens a page in its own pane.
const { addHook } = require('../../session/hookChain.cjs');

/** What the rail shows of a server: never its process, output or launch details. */
const view = (s) => ({
  id: s.id,
  name: s.name ?? null,
  url: s.url ?? null,
  port: s.port ?? null,
  status: s.status,
  live: !!s.live,
});

/**
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @param {{ live: { devPreviews?: any }, broadcastAll: (channel: string, ...args: any[]) => void }} deps
 */
function register(ipcMain, { live, broadcastAll }) {
  const watched = new WeakSet();
  // the registry exists once previews are wired; watch it the first time a window asks
  const previews = () => {
    const p = live.devPreviews ?? null;
    if (p && !watched.has(p)) {
      watched.add(p);
      const changed = (s) => broadcastAll('previews:changed', { chatId: s.chatId });
      addHook(p, 'onChange', changed);
      addHook(p, 'onReady', changed);
      addHook(p, 'onExit', changed);
    }
    return p;
  };
  ipcMain.handle('previews:list', (_e, chatId) => (typeof chatId === 'string' ? (previews()?.list(chatId) ?? []).map(view) : []));
  ipcMain.handle('previews:stop', (_e, chatId, id) => {
    const p = previews();
    // one already gone (a second click, another window's stop) has nothing left to stop
    if (!p || typeof chatId !== 'string' || !p.list(chatId).some((s) => s.id === String(id))) return false;
    p.stop(chatId, String(id));
    return true;
  });
}

module.exports = { register, view };
