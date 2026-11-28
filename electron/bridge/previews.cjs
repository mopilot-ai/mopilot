// window.native.previews: a chat's dev-preview servers for the session rail's Servers section (electron/app/ipc/previews.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('previews:list', 1),
  stop: invoke('previews:stop', 2),
  /** a server became ready, exited or was stopped: read the chat's list again */
  onChanged: on('previews:changed'),
};
