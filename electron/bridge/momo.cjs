// window.native.momo: whether MoMo exists for this account (the closed-alpha gate, electron/momo/access.cjs) and its changes.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  access: invoke('momo:access'),
  onAccess: on('momo:access'),
};
