// Optional installation reporting interface; the public app performs no pings without its private module.
const { optionalAnalytics } = require('./optionalAnalytics.cjs');
class NoInstallPing {
  start() {
    /* Optional service disabled. */
  }
  stop() {
    /* Optional service disabled. */
  }
  async tick() {
    return false;
  }
}
const privateApi = optionalAnalytics('installPing', null);
module.exports = { InstallPing: privateApi?.InstallPing ?? NoInstallPing, CHECK_MS: privateApi?.CHECK_MS, utcDay: privateApi?.utcDay };
