// window.native.context: a chat's context snapshot, a fresh read of it, and each change main publishes (electron/app/ipc/context.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  get: invoke('context:get', 1),
  refresh: invoke('context:refresh', 2),
  onSnapshot: on('context:snapshot'),
};
