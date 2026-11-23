// MoMo's files (Outputs) wired in main, moved out of app/momo.cjs unchanged: the Outputs section of MoMo's right panel (the user's own Open, Show in Finder, Save a copy and Delete on a saved file), and MoMo's own tools for saving text files in its folder (decided without a card, audited by the same gate), both behind the `momo.outputs` flag, which is read on every call and never cached.
const { registerOutputsTools, SOURCE: OUTPUTS_SOURCE } = require('../momo/outputsTools.cjs');
const { registerOutputsIpc } = require('../momo/outputsIpc.cjs');
const { isEnabled } = require('../platform/flags.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** Whether MoMo Outputs is on now (shared/flagDefs.mjs `momo.outputs`). */
const outputsFlag = () => isEnabled('momo.outputs');

/**
 * The panel's calls: Open, Show in Finder, Save a copy and Delete on a file MoMo saved.
 * @param {any} ipcMain
 * @param {{ sources: any, allowed: () => boolean, shell: any, dialog: any, BrowserWindow: any, broadcast: (channel: string) => void }} d
 */
function registerOutputs(ipcMain, { sources, allowed, shell, dialog, BrowserWindow, broadcast }) {
  registerOutputsIpc(ipcMain, {
    store: sources.outputs,
    allowed,
    enabled: outputsFlag,
    openPath: (/** @type {string} */ p) => shell.openPath(p),
    reveal: (/** @type {string} */ p) => shell.showItemInFolder(p),
    pickCopy: async (/** @type {any} */ e, /** @type {string} */ name) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) throw new Error('Not an app window');
      const r = await dialog.showSaveDialog(win, { defaultPath: name });
      return r.canceled ? null : (r.filePath ?? null);
    },
    broadcast,
  });
}

/**
 * MoMo's file tools, and the sweep of its folder at startup (only with the flag on: with it off the folder is not touched, and only Reset MoMo removes what is there).
 * @param {any} registry
 * @param {{ sources: any, trust: any, sentinel: any, allowed: () => boolean, isMomoChat: (chatId: string) => boolean, owner: any }} d
 */
function registerOutputsFor(registry, { sources, trust, sentinel, allowed, isMomoChat, owner }) {
  sentinel.setSource(OUTPUTS_SOURCE, { level: 'ask', private: false, name: 'MoMo files' });
  registerOutputsTools(registry, {
    store: sources.outputs,
    trust,
    tainted: (/** @type {string} */ id) => sentinel.tainted(id),
    enabled: outputsFlag,
    allowed,
    isMomoChat,
    owner,
  });
  if (outputsFlag()) void sources.outputs.sweep().catch((e) => noteIgnored('sweep MoMo files', e));
}

module.exports = { outputsFlag, registerOutputs, registerOutputsFor };
