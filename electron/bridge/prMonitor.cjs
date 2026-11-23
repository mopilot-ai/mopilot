// window.native.prMonitor: per-chat PR binding, autofix preferences, refresh, stacking, create and merge, and background status updates.
const { invoke, on } = require('./spec.cjs');
module.exports = {
  snapshot: invoke('prMonitor:snapshot', 1),
  configure: invoke('prMonitor:configure', 2),
  refresh: invoke('prMonitor:refresh', 1),
  stackCandidates: invoke('prMonitor:stackCandidates', 2),
  stack: invoke('prMonitor:stack', 3),
  createDraft: invoke('prMonitor:createDraft', 1),
  create: invoke('prMonitor:create', 2),
  merge: invoke('prMonitor:merge', 3),
  onChanged: on('prMonitor:changed'),
};
