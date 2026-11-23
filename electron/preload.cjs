// The renderer's preload bridge: exposes window.native, the IPC calls, events and remote flags the windows use.
// Each window.native.<namespace> is declared in its own electron/bridge/<namespace>.cjs (electron/bridge/spec.cjs):
// only the channels those files name are exposed, so a feature adds its own file instead of editing this one.
// It requires those files, so the windows that load it run it unsandboxed (sandbox: false, contextIsolation on; electron/app/windows.cjs).

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { loadBridge, buildApi, on, unpackStreamBatches } = require('./bridge/spec.cjs');
const { hasMoPilotService } = require('./platform/mopilotPresence.cjs');

// Remote kill switches (electron/platform/flags.cjs): read once synchronously, then kept current.
let flagSnap = null;
let flagsWarned = false;
ipcRenderer.on('flags:changed', (_e, snap) => (flagSnap = snap));
const flagsNow = () => {
  if (!flagSnap) {
    try {
      flagSnap = ipcRenderer.sendSync('flags:getSync') || null;
    } catch (error) {
      // main not ready: every switch reads as off until a later call gets them (the sandbox has no main-process
      // helper to record this, so it goes to the window's console)
      if (!flagsWarned) console.warn('[flags] could not read the remote switches:', error);
      flagsWarned = true;
    }
  }
  return flagSnap || {};
};

unpackStreamBatches(ipcRenderer, globalThis.window);
const electron = { ipcRenderer, webUtils };
contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  // whether this build has the MoPilot service (account, credits, phone pairing, sending bug reports); the open-source edition has none
  mopilotService: hasMoPilotService(),
  flags: {
    isEnabled: (key) => flagsNow()[key] === true,
    all: () => ({ ...flagsNow() }),
    onChanged: buildApi({ onChanged: on('flags:changed') }, electron).onChanged,
  },
  ...buildApi(loadBridge(), electron),
});
