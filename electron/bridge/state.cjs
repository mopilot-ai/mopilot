// window.native.state: ui-state.json (electron/app/ipc/chats.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  read: invoke('state:read'),
  write: invoke('state:write', 1),
};
