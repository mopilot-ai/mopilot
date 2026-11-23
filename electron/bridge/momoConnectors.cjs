// window.native.momoConnectors: the cloud accounts' rows in Settings › MoMo › Sources (#2999 C0): each connector's status (never a token), the browser sign-in and its cancel, disconnect and the access level (electron/momo/connectors/ipc.cjs, which refuses every call but disconnect while MoMo is not allowed).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoConnectors:list'),
  /** opens the provider's sign-in in the browser; answers when the account is connected, or why not */
  connect: invoke('momoConnectors:connect', 1),
  /** ends the sign-in waiting for the browser */
  cancel: invoke('momoConnectors:cancel', 1),
  /** forgets the account's tokens */
  disconnect: invoke('momoConnectors:disconnect', 1),
  setLevel: invoke('momoConnectors:setLevel', 2),
  /** a connector was connected, disconnected or changed: read the list again */
  onChanged: on('momoConnectors:changed'),
};
