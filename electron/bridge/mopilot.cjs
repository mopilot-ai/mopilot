// window.native.mopilot: the MoPilot account and its gateway (electron/identity/mopilot.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  status: invoke('mopilot:status'),
  refresh: invoke('mopilot:refresh'),
  signIn: invoke('mopilot:signIn'),
  cancelSignIn: invoke('mopilot:cancelSignIn'),
  signOut: invoke('mopilot:signOut'),
  openWeb: invoke('mopilot:openWeb', 1),
  onEvent: on('mopilot:event'),
};
