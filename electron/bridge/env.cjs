// window.native.env: environment setup scripts and files (electron/platform/git.cjs) and the resolved config (electron/app/ipc/environment.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  runScript: invoke('env:runScript', 2),
  write: invoke('env:write', 2),
  resolve: invoke('env:resolve', 1),
  convert: invoke('env:convert', 1),
};
