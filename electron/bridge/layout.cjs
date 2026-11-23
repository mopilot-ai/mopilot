// window.native.layout: main's window tools ask this window to change its split view layout (electron/capabilities/tools/windowTools.cjs).
const { send, on } = require('./spec.cjs');

module.exports = {
  onRequest: on('window:layout'),
  reply: send('window:layout:reply', 2),
};
