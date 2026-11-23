// window.native.alwaysOn: Mobile Remote's keep-running, login-item and sleep switches (electron/app/ipc/alwaysOn.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  get: invoke('alwaysOn:get'),
  set: invoke('alwaysOn:set', 1),
  onChanged: on('alwaysOn:changed'),
};
