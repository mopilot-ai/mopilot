// window.native.recordings: saved dictation recordings (electron/app/ipc/files.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  save: invoke('recordings:save', 2),
  list: invoke('recordings:list'),
  read: invoke('recordings:read', 1),
  clear: invoke('recordings:clear'),
};
