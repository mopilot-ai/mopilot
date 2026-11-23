// window.native.voice: the voice hotkey (electron/app/ipc/window.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  setHotkey: invoke('voice:hotkey', 1),
};
