// Loaded into the app's main process before it starts (the `mainRequire` fixture option, Electron's -r) by the saved PR
// replies journey: which chats a window asked main for their replies-only history (`peer:referenceHistory` with
// assistantOnly, the sidebar PR badge's read), in order. Read back through global.__historyReads().
const { ipcMain } = require('electron');

/** @type {string[]} */
const reads = [];
const handle = ipcMain.handle;
ipcMain.handle = function (channel, listener) {
  const counted =
    channel === 'peer:referenceHistory'
      ? (/** @type {any} */ e, /** @type {unknown} */ ids, /** @type {unknown} */ assistantOnly, /** @type {any[]} */ ...rest) => {
          if (assistantOnly === true && Array.isArray(ids)) reads.push(...ids.map(String));
          return listener(e, ids, assistantOnly, ...rest);
        }
      : listener;
  return handle.call(this, channel, counted);
};

global.__historyReads = () => [...reads];
