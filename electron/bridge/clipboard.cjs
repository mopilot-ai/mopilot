// window.native.clipboard: writing the clipboard (electron/app/ipc/window.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  write: invoke('clipboard:write', 1),
};
