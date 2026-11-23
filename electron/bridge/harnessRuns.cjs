// window.native.harnessRuns: harness install commands run in a terminal main owns (electron/app/ipc/harnessRuns.cjs).
const { invoke, send, on } = require('./spec.cjs');

module.exports = {
  tools: invoke('harnessRuns:tools'),
  list: invoke('harnessRuns:list'),
  find: invoke('harnessRuns:find', 1),
  start: invoke('harnessRuns:start', 3),
  attach: invoke('harnessRuns:attach', 1),
  write: send('harnessRuns:write', 2),
  resize: send('harnessRuns:resize', 3),
  stop: invoke('harnessRuns:stop', 1),
  dismiss: invoke('harnessRuns:dismiss', 1),
  onState: on('harnessRuns:state'),
  onData: on('harnessRuns:data'),
};
