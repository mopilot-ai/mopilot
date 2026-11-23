// window.native.exitGate: Quit and Restart to update ask here first (electron/platform/exitGate.cjs).
const { send, on } = require('./spec.cjs');

module.exports = {
  onConfirm: on('exitGate:confirm'),
  answer: send('exitGate:confirm:reply', 2),
};
