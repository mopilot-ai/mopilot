// window.native.linear: the Linear connection (the user's own API key, kept encrypted in main) and reading an issue to start a chat from (electron/platform/linearSource.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  status: invoke('linear:status'),
  connect: invoke('linear:connect', 1),
  disconnect: invoke('linear:disconnect'),
  issue: invoke('linear:issue', 1),
};
