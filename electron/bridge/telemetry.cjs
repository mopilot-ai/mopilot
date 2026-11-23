// window.native.telemetry: usage data and its consent (electron/support/telemetry.cjs).
const { invoke, send } = require('./spec.cjs');

module.exports = {
  track: send('telemetry:track', 2),
  rate: send('telemetry:rate', 1),
  error: send('telemetry:error', 1),
  shareTurn: send('telemetry:shareTurn', 1),
  setConsent: invoke('telemetry:consent', 1),
};
