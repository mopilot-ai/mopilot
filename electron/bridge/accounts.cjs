// window.native.accounts: Codex accounts: sign-in, switching, pooling and usage (electron/identity/codexAccounts.cjs).
const { invoke, call, on } = require('./spec.cjs');

module.exports = {
  list: invoke('accounts:list'),
  apply: invoke('accounts:apply'),
  switchTo: invoke('accounts:switch', 1),
  login: invoke('accounts:login', 1),
  cancelLogin: invoke('accounts:cancelLogin'),
  remove: invoke('accounts:remove', 1),
  addApiKey: invoke('accounts:addApiKey', 3),
  setMode: invoke('accounts:setMode', 1),
  refreshUsage: invoke('accounts:refreshUsage', 1),
  resetCredits: call('accounts:resetCredits'),
  consumeResetCredit: call('accounts:consumeResetCredit'),
  setAutoSwitch: invoke('accounts:setAutoSwitch', 1),
  setPool: invoke('accounts:setPool', 1),
  pinChat: invoke('accounts:pinChat', 2),
  onEvent: on('accounts:event'),
};
