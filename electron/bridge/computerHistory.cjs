// window.native.computerHistory: Computer History (#1363): its state and settings, Pause / Resume, the allow lists, the days and their memories, Delete day and Delete all (electron/app/ipc/computerHistory.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  state: invoke('computerHistory:state'),
  setEnabled: invoke('computerHistory:setEnabled', 1),
  pause: invoke('computerHistory:pause'),
  resume: invoke('computerHistory:resume'),
  allowApp: invoke('computerHistory:allowApp', 1),
  removeApp: invoke('computerHistory:removeApp', 1),
  allowSite: invoke('computerHistory:allowSite', 1),
  removeSite: invoke('computerHistory:removeSite', 1),
  setRetention: invoke('computerHistory:setRetention', 1),
  explainerSeen: invoke('computerHistory:explainerSeen'),
  days: invoke('computerHistory:days'),
  memories: invoke('computerHistory:memories', 1),
  deleteDay: invoke('computerHistory:deleteDay', 1),
  deleteAll: invoke('computerHistory:deleteAll'),
  /** the apps running now, each with why Computer History never records it (null when it may) */
  candidates: invoke('computerHistory:candidates'),
  onChanged: on('computerHistory:changed'),
};
