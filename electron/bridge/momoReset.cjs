// window.native.momoReset: Reset MoMo (electron/app/ipc/momoReset.cjs): pause, delete every MoMo store, reset its settings.
const { call } = require('./spec.cjs');

module.exports = {
  run: call('momoReset:run'),
};
