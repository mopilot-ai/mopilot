// window.native.browserUse: Codex Browser Use settings: $CODEX_HOME/browser/config.toml (electron/capabilities/browser/codexBrowserUse.cjs).
const { call } = require('./spec.cjs');

module.exports = {
  state: call('browserUse:state'),
  setPreference: call('browserUse:setPreference'),
  setRule: call('browserUse:setRule'),
  forget: call('browserUse:forget'),
};
