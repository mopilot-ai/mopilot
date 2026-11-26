// Preload-document leases retire speech and draft ownership on navigation, renderer loss and window destruction.
const crypto = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');

function createSpeechWindows(retire = (_owner) => undefined) {
  // every service built on these leases hears a retire (speech, Mobile Remote's pairing, pairing by code): a list, never one slot
  /** @type {Set<(owner: string) => void>} */
  const retirers = new Set([retire]);
  const valid = (event) =>
    !event.sender.isDestroyed() && !!event.senderFrame && !event.senderFrame.detached && event.senderFrame === event.sender.mainFrame;
  const windows = new WeakMap();
  const close = (state) => {
    if (!state.owner) return;
    const owner = state.owner;
    state.owner = null;
    for (const fn of [...retirers]) {
      try {
        fn(owner);
      } catch (error) {
        noteIgnored('tell a service its page went away', error);
      }
    }
  };
  return {
    /** Adds a listener; what it returns removes it. @param {(owner: string) => void} callback */
    onRetire(callback) {
      retirers.add(callback);
      return () => void retirers.delete(callback);
    },
    open(event) {
      const sender = event.sender;
      if (!valid(event)) return null;
      let state = windows.get(sender);
      if (!state) {
        state = { owner: null, destroyed: false };
        windows.set(sender, state);
        sender.on('did-start-navigation', (details, _url, legacySame, legacyMain) => {
          if ((details.isMainFrame ?? legacyMain) && !(details.isSameDocument ?? legacySame)) close(state);
        });
        sender.on('render-process-gone', () => close(state));
        sender.once('destroyed', () => {
          state.destroyed = true;
          close(state);
        });
      }
      if (state.destroyed) return null;
      close(state);
      state.owner = crypto.randomUUID();
      return state.owner;
    },
    owner(event, token) {
      const state = windows.get(event.sender);
      if (!valid(event) || !state || !token || state.owner !== token || state.destroyed)
        throw new Error('This voice input belongs to an earlier page. Reload the window to try again.');
      return token;
    },
  };
}
const registered = new WeakMap();
/** Register before the first preload; attach services only after startup has opened them. */
function registerSpeechWindows(ipcMain, retire) {
  let service = registered.get(ipcMain);
  if (!service) {
    service = createSpeechWindows();
    registered.set(ipcMain, service);
    ipcMain.on('speech:document', (event) => {
      event.returnValue = service.open(event);
    });
  }
  if (retire) service.onRetire(retire);
  return service;
}
module.exports = { createSpeechWindows, registerSpeechWindows };
