// window.native.acp: ACP (basic) harnesses: admission, sessions and permissions (electron/harness/acp.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  harnesses: invoke('acp:harnesses'),
  registryList: invoke('acp:registryList', 1),
  registryInstall: invoke('acp:registryInstall', 1),
  registryRepair: invoke('acp:registryRepair', 1),
  recheck: invoke('acp:recheck', 1),
  authenticate: invoke('acp:authenticate', 2),
  signIns: invoke('acp:signIns'),
  cancelSignIn: invoke('acp:cancelSignIn', 1),
  onSignIns: on('acp:signIns'),
  onHarnesses: on('acp:harnesses'),
  permission: invoke('acp:permission', 2),
  turns: invoke('acp:turns', 4),
  list: invoke('acp:list'),
  search: invoke('acp:search', 3),
  rename: invoke('acp:rename', 2),
  setMode: invoke('acp:setMode', 2),
  setConfigOption: invoke('acp:setConfigOption', 3),
  recordedSettings: invoke('acp:recordedSettings', 1),
  ownMcp: invoke('acp:ownMcp', 2),
  onEvent: on('acp:event'),
  onItems: on('acp:items'),
};
