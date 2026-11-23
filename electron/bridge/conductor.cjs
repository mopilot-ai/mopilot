// window.native.conductor: finding and importing a Conductor user's repositories and workspaces (electron/platform/conductorImport.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  discover: invoke('conductor:discover'),
  import: invoke('conductor:import', 1),
};
