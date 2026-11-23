// window.native.harnessUpdates: each installed harness's version and update (electron/app/ipc/harnessUpdates.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  state: invoke('harnessUpdates:state'),
  check: invoke('harnessUpdates:check', 1),
  update: invoke('harnessUpdates:update', 2),
  cancelWait: invoke('harnessUpdates:cancelWait', 1),
  updateAll: invoke('harnessUpdates:updateAll'),
  cancelAll: invoke('harnessUpdates:cancelAll'),
  onState: on('harnessUpdates:state'),
};
