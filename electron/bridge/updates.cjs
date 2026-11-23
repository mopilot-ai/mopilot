// window.native.updates: app updates (electron/app/updates.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  state: invoke('updates:state'),
  check: invoke('updates:check'),
  install: invoke('updates:install', 1),
  configure: invoke('updates:configure', 1),
  onState: on('updates:state'),
};
