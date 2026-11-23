// Pairing document leases retire on navigation, renderer loss and window destruction.
const { createSpeechWindows } = require('../platform/speechWindows.cjs');
const registered = new WeakMap();
function registerRemoteWindows(ipcMain, retire) {
  let windows = registered.get(ipcMain);
  if (!windows) {
    windows = createSpeechWindows();
    registered.set(ipcMain, windows);
    ipcMain.on('remoteSettings:document', (event) => {
      event.returnValue = windows.open(event);
    });
  }
  if (retire) windows.onRetire(retire);
  return windows;
}
module.exports = { registerRemoteWindows };
