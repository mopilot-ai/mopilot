// window.native.prefs: preferences in ui-state.json (electron/platform/chats.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  recording: invoke('prefs:recording', 1),
  binding: invoke('prefs:binding', 2),
  patch: invoke('prefs:patch', 2),
  onChanged: on('prefs:changed'),
};
