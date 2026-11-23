// window.native.codex: the Codex app-server and the Codex adapter in main (electron/app/ipc/harnesses.cjs, electron/harness/codex.cjs).
const { invoke, call, on } = require('./spec.cjs');

module.exports = {
  start: invoke('codex:start'),
  restart: invoke('codex:restart'),
  used: invoke('codex:used'),
  binaries: invoke('codex:binaries'),
  /* the Codex adapter in main (electron/harness/codex.cjs) */
  connect: call('codex:connect'),
  request: call('codex:request'),
  api: call('codex:api'),
  respond: call('codex:respond'),
  onStatus: on('codex:status'),
  onItem: on('codex:item'),
  leases: call('codex:leases'),
  negotiated: call('codex:negotiated'),
  resume: call('codex:resume'),
  pinLease: call('codex:pinLease'),
  leased: call('codex:leased'),
  startThread: call('codex:startThread'),
  fork: call('codex:fork'),
  watchRollout: invoke('codex:watchRollout', 2),
  unwatchRollout: invoke('codex:unwatchRollout', 1),
  onRollout: on('codex:rollout'),
  rolloutHistory: invoke('codex:rolloutHistory', 2),
};
