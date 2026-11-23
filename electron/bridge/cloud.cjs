// window.native.cloud: Codex Cloud tasks (electron/app/ipc/accounts.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  envs: invoke('cloud:envs'),
  exec: invoke('cloud:exec', 4),
  list: invoke('cloud:list', 1),
  status: invoke('cloud:status', 1),
  diff: invoke('cloud:diff', 2),
  apply: invoke('cloud:apply', 3),
};
