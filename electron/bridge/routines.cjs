// window.native.routines: routines (#3571, G4): the user's saved routines for Settings, renaming and deleting one, and keeping a chat's last turn as one (electron/app/ipc/routines.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('routines:list'),
  saveLast: invoke('routines:saveLast', 2),
  edit: invoke('routines:edit', 3),
  remove: invoke('routines:remove', 1),
  onChanged: on('routines:changed'),
};
