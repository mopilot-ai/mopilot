// window.native.pty: terminals (electron/platform/pty.cjs).
const { invoke, send, on } = require('./spec.cjs');

module.exports = {
  spawn: invoke('platform:pty:spawn', 2),
  write: send('platform:pty:write', 2),
  resize: send('platform:pty:resize', 3),
  kill: invoke('platform:pty:kill', 1),
  onEvent: on('platform:pty:event'),
};
