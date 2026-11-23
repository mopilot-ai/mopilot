// window.native.superagent: Settings › Superagent (S1, watch only), see electron/app/ipc/superagent.cjs.
const { call, on } = require('./spec.cjs');

module.exports = {
  state: call('superagent:state'),
  setRepo: call('superagent:setRepo'),
  setAllowed: call('superagent:setAllowed'),
  setRule: call('superagent:setRule'),
  setPaused: call('superagent:setPaused'),
  mark: call('superagent:mark'),
  acknowledge: call('superagent:acknowledge'),
  onChanged: on('superagent:changed'),
};
