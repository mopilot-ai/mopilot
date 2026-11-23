// The acp:* IPC: what windows ask of the ACP host (permissions, history, the chat list and search, a chat's settings), and its events back to them.
const { searchCaller } = require('../../platform/searchScans.cjs');
const { answerAcpCard, acpCardRoutes } = require('./cardAnswer.cjs');
const { historySource } = require('./audio.cjs');
const { userError } = require('../../../shared/userError.mjs');

/**
 * acp:* IPC for the windows; events go out on acp:event. Sends and Stop go through the ChatController.
 * @param ipcMain
 * @param host AcpHost
 * @param {{ broadcast: (channel: string, payload: any) => void, onPermission?: (requestId: string) => void, routes?: any,
 *   diffs?: (key: string, turnIds: string[]) => Record<string, string>, items: InstanceType<typeof import('../items/acp.cjs').AcpItems> }} o routes: main's `live`, whose `remoteChats()` answers a card of a chat on another machine; diffs: what
 *   each of these turns changed in its folder, by turn id; items: main's translation of the chats (acp:turns)
 */
function register(
  ipcMain,
  host,
  {
    broadcast,
    onPermission = () => {
      /* no listener */
    },
    routes = {},
    diffs = () => ({}),
    items,
  },
) {
  host.on('event', (e) => broadcast('acp:event', e));
  // a card of a chat on another machine is answered there, and leaves only once that machine took it
  ipcMain.handle('acp:permission', (_e, requestId, optionId) =>
    answerAcpCard(acpCardRoutes(routes.remoteChats, host, onPermission), String(requestId), optionId ?? null),
  );
  // the transcript as turns, translated in main
  ipcMain.handle('acp:turns', async (_e, key, chatId, cwd, opts) => {
    const read = () => historySource(host, String(key));
    const { page, ids, activeTurnId } = await items.history(String(key), String(chatId), String(cwd ?? ''), read, opts);
    // of this page only, as of the step that settled it; the window lays them on the turns it parses
    return { page, activeTurnId, diffs: diffs(String(key), ids) };
  });
  ipcMain.handle('acp:list', () => host.list());
  ipcMain.handle('acp:search', (e, term, limit, scope) => host.search(term, limit, searchCaller(e, scope)));
  ipcMain.handle('acp:setMode', (_e, key, modeId) => host.setMode(String(key), String(modeId)));
  ipcMain.handle('acp:setConfigOption', (_e, key, configId, value) => host.setConfigOption(String(key), String(configId), value));
  // the name is kept here first; a chat on a machine answers whether the machine took it: null, or why not (`{ error }`)
  ipcMain.handle('acp:rename', (_e, key, name) => {
    const sent = host.rename(String(key), name);
    return typeof sent?.then === 'function'
      ? sent.then(
          () => null,
          // a sentence the Mac itself worded for a machine (remoteRename.cjs) is shown as it is: userError would capitalise the machine's name
          (error) => ({
            error: error?.worded === true ? String(error.message) : userError(error),
            ...(error?.worded === true ? { hostId: error.hostId } : {}),
          }),
        )
      : null;
  });
}

module.exports = { register };
