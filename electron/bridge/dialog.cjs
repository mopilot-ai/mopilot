// window.native.dialog: open and save dialogs (electron/app/ipc/window.cjs, electron/app/ipc/files.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  openFolder: invoke('dialog:openFolder'),
  openFiles: invoke('dialog:openFiles', 1),
  saveText: invoke('dialog:saveText', 2),
};
