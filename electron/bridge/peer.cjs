// window.native.peer: chat-to-chat messages (electron/session/peerRuntime.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  snapshot: invoke('peer:snapshot', 1),
  directory: invoke('peer:directory', 2),
  capabilities: invoke('peer:capabilities', 1),
  referenceHistory: invoke('peer:referenceHistory', 3),
  send: invoke('peer:send', 2),
  reply: invoke('peer:reply', 2),
  cancel: invoke('peer:cancel', 2),
  sendNow: invoke('peer:sendNow', 2),
  resume: invoke('peer:resume', 2),
  reconcile: invoke('peer:reconcile', 2),
  approve: invoke('peer:approve', 2),
  decline: invoke('peer:decline', 2),
  onChanged: on('peer:changed'),
};
