// window.native.routing: routed chats' providers, named model configs and provider keys (electron/app/ipc/routing.cjs); a key goes in and never comes back.
const { call, on } = require('./spec.cjs');

module.exports = {
  providers: call('routing:providers'),
  configs: call('routing:configs'),
  saveConfig: call('routing:saveConfig'),
  removeConfig: call('routing:removeConfig'),
  hasKey: call('routing:hasKey'),
  setKey: call('routing:setKey'),
  clearKey: call('routing:clearKey'),
  onChanged: on('routing:changed'),
};
