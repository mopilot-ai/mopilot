// window.native.checkpoints: restoring a chat's files when it is rewound, from each turn's start snapshot (electron/session/turnCheckpoints.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  plan: invoke('checkpoints:plan', 3),
  restore: invoke('checkpoints:restore', 4),
  undo: invoke('checkpoints:undo', 3),
};
