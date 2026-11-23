// window.native.computerAccess: Settings → Computer access (#1364): this Mac's side and the computers this install uses (electron/app/ipc/computerAccess.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  state: invoke('computerAccess:state'),
  setEnabled: invoke('computerAccess:setEnabled', 1),
  setLan: invoke('computerAccess:setLan', 1),
  startPairing: invoke('computerAccess:startPairing'),
  cancelPairing: invoke('computerAccess:cancelPairing'),
  answerPairing: invoke('computerAccess:answerPairing', 2),
  setDevice: invoke('computerAccess:setDevice', 2),
  revoke: invoke('computerAccess:revoke', 1),
  stop: invoke('computerAccess:stop', 1),
  log: invoke('computerAccess:log', 1),
  reset: invoke('computerAccess:reset'),
  pair: invoke('computerAccess:pair', 1),
  forget: invoke('computerAccess:forget', 1),
  onChanged: on('computerAccess:changed'),
  onPaired: on('computerAccess:paired'),
};
