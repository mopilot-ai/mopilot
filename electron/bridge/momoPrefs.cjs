// window.native.momoPrefs: MoMo's settings (electron/app/ipc/momoPrefs.cjs): set one key of prefs.momo.
const { call } = require('./spec.cjs');

module.exports = {
  set: call('momoPrefs:set'),
};
