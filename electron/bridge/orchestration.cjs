// window.native.orchestration: linked sessions, the chats one chat started (electron/session/orchestration).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  snapshot: invoke('orchestration:snapshot', 0),
  task: invoke('orchestration:task', 3),
  child: invoke('orchestration:child', 2),
  archiveFamily: invoke('orchestration:archiveFamily', 3),
  onChanged: on('orchestration:changed'),
};
