// Stable diagnostics/consent interface; the private implementation is absent from default OSS packages and exports.
const { optionalAnalytics } = require('./optionalAnalytics.cjs');
const { fingerprint, osName } = require('./diagnosticIdentity.cjs');
const { mergeConsent } = require('./usageConsent.cjs');

class NoTelemetry {
  constructor() {
    this.consent = false;
  }
  startCrashReporter() {
    /* Optional service disabled. */
  }
  start() {
    /* Optional service disabled. */
  }
  setConsent() {
    /* Optional service disabled. */
  }
  identityChanged() {
    /* No optional observer to retire. */
  }
  track() {
    /* Optional service disabled. */
  }
  rate() {
    /* Optional service disabled. */
  }
  error() {
    /* Optional service disabled. */
  }
  shareTurn() {
    /* Optional service disabled. */
  }
  reportMigration() {
    return false;
  }
  async reportContext() {
    return { channel: 'unknown', versions: null, fingerprints: [] };
  }
  async flush() {
    /* Optional service disabled. */
  }
  persist() {
    /* Optional service disabled. */
  }
  /** The window still sends usage events (electron/bridge/telemetry.cjs); with the service absent they end here. */
  register(ipcMain) {
    for (const channel of ['telemetry:track', 'telemetry:rate', 'telemetry:error', 'telemetry:shareTurn'])
      ipcMain.on(channel, () => {
        /* Optional service disabled. */
      });
  }
}

const privateApi = optionalAnalytics('telemetry', null);
module.exports = {
  Telemetry: privateApi?.Telemetry ?? NoTelemetry,
  mergeConsent,
  fingerprint,
  osName,
  harnessVersions: privateApi?.harnessVersions ?? (() => null),
  REPORT_MARKER: privateApi?.REPORT_MARKER ?? '',
  redactToolCalls: privateApi?.redactToolCalls,
  EVENTS: privateApi?.EVENTS,
  migrationReport: privateApi?.migrationReport,
  codexVersionOf: privateApi?.codexVersionOf,
};
