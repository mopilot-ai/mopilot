// The remote methods on the Mac's notification settings (phones only): read them, and change chat titles in push, the notification mode, the per-kind switches and MoMo's quiet hours.
const { RemoteError } = require('../serviceErrors.cjs');

function opsOf(/** @type {any} */ svc) {
  const ops = svc.pushSettings;
  if (!ops) throw new RemoteError('failed', 'This Mac has no notification settings to change.');
  return ops;
}

module.exports = {
  'push.settings.get': async (svc) => opsOf(svc).get(),
  'push.settings.set': async (svc, _client, p) => opsOf(svc).set(p),
};
