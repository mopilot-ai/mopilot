// window.native.routes: whether each harness's own config sends it to a gateway or another endpoint, Restart to apply and revealing the config file (electron/harness/routes.cjs, electron/app/ipc/routes.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('routes:list'),
  refresh: invoke('routes:refresh'),
  onChanged: on('routes:changed'),
  reveal: invoke('routes:reveal', 1),
  restartIdle: invoke('routes:restartIdle', 1),
};
