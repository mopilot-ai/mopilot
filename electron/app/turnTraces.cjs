// The turn trace in main (#3571, G5): one TurnTraces for the built-in browser's tools, on while the shared.browser.turnTrace flag and the user's "Record turn replays" setting are both on, saving into each chat's browser-traces folder, ending with each chat's turn, and listed to the window for the Replay on a turn (browser:turnTraces).
const { TurnTraces } = require('../capabilities/browser/devtools/turnTrace.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { chatFolder } = require('../capabilities/browser/chatFolders.cjs');

/**
 * @param {{ ipcMain: { handle: (channel: string, fn: (...a: any[]) => any) => void }, hostTabs: any, dir: string,
 *           isFlagEnabled: (key: string) => boolean, readState: () => any,
 *           browserGrants: { riskOf: (url: string) => { level: string, credentials?: boolean } },
 *           broadcastAll: (channel: string, payload: unknown) => void }} o
 *   hostTabs: the chats' tabs by Host: this Mac's (`local`) page gates feed the trace (hostPageGates.cjs), and it tells every chat's turn end;
 *   dir: the browser's data folder, where each chat's browser-traces folder is (chatFolders.cjs)
 */
function createTurnTraces({ ipcMain, hostTabs, dir, isFlagEnabled, readState, browserGrants, broadcastAll }) {
  const on = () => {
    if (!isFlagEnabled('shared.browser.turnTrace')) return false;
    try {
      return readState().prefs?.browserTurnTrace === true;
    } catch (error) {
      noteIgnored('read whether turn replays are on', error);
      return false;
    }
  };
  const traces = new TurnTraces({
    enabled: on,
    root: (chatId) => chatFolder(dir, 'browser-traces', chatId),
    // each frame is a file of its own: a tab resized mid-turn needs no re-encoding
    riskOf: (url) => browserGrants.riskOf(url),
    onSaved: (chatId, summary) => broadcastAll('browser:traceSaved', { chatId, ...summary }),
  });
  hostTabs.local.traces = traces;
  hostTabs.onTurnEnd((/** @type {string} */ chatId) => void traces.endTurn(chatId));
  ipcMain.handle('browser:turnTraces', (_e, /** @type {unknown} */ chatId) =>
    typeof chatId === 'string' && chatId ? traces.list(chatId) : [],
  );
  return traces;
}

module.exports = { createTurnTraces };
