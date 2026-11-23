// window.native.gateway: the MCP gateway's managed servers, adding and removing one, saving or forgetting its credential, and restarting it (electron/app/ipc/gateway.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('gateway:list'),
  add: invoke('gateway:add', 1),
  remove: invoke('gateway:remove', 1),
  connect: invoke('gateway:connect', 2),
  disconnect: invoke('gateway:disconnect', 1),
  restart: invoke('gateway:restart', 1),
  signIn: invoke('gateway:signIn', 1),
  cancelSignIn: invoke('gateway:cancelSignIn', 1),
  rules: invoke('gateway:rules'),
  addRule: invoke('gateway:addRule', 1),
  removeRule: invoke('gateway:removeRule', 1),
  resetRules: invoke('gateway:resetRules'),
  /** a server was added, removed, connected, started or changed its tools: read the list again */
  onChanged: on('gateway:changed'),
};
