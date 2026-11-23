// window.native.shell: opening links, files and folders in other apps (electron/app/ipc/window.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  openExternal: invoke('shell:openExternal', 1),
  openPath: invoke('shell:openPath', 1),
  reveal: invoke('shell:reveal', 1),
  openIn: invoke('shell:openIn', 2),
};
