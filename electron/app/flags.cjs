// Remote switches in main: loaded at 'ready' from MoPilot's flags endpoint (built-in defaults in a build without the
// MoPilot service), and what main redoes when one changes.
const path = require('node:path');
const { initFlags, isEnabled, registerFlags, parseOverride: parseFlagOverride } = require('../platform/flags.cjs');
const { FLAGS_URL } = require('../platform/mopilotEndpoints.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { syncProbe } = require('../perf/probe.cjs');
const { coreLoaded } = require('../platform/core.cjs');
const { recomputeMomoAccess } = require('../momo/access.cjs');
const { recomputeHostAccess } = require('../host/access.cjs');
const { recomputePhoneAccess } = require('../remote/phoneAccess.cjs');

/**
 * @param {import('../main.cjs').FlagsDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function openFlags({ app, ipcMain, broadcastAll, capsChanged, chromeState, live }) {
  const flags = initFlags({
    file: path.join(app.getPath('userData'), 'flags.json'),
    url: FLAGS_URL,
    channel: () => live.updater.channel,
    version: app.getVersion(),
    // MOPILOT_FLAGS overrides switches in an unpackaged build (e2e tests, development; `@dev` turns on flags in development)
    override: app.isPackaged ? {} : parseFlagOverride(process.env.MOPILOT_FLAGS),
    onKill: (key) => live.telemetry?.track('kill_switch_applied', { key, channel: live.updater.channel, version: app.getVersion() }),
    onChange: (snap) => {
      syncProbe(snap['shared.perf.probe'], app.getPath('userData'), coreLoaded);
      live.computerUse?.sync();
      live.computerAccess?.sync();
      broadcastAll('flags:changed', snap);
      // the MoMo kill switch (electron/momo/access.cjs)
      recomputeMomoAccess();
      // and Host's (electron/host/access.cjs)
      recomputeHostAccess();
      // and Mobile Remote's (electron/remote/phoneAccess.cjs)
      recomputePhoneAccess();
      // Mobile Remote follows its switch (electron/remote/runtime.cjs)
      void live.remote?.sync();
      // a switch may change what a surface can do (computer use, a tool channel): open settings read the status again
      broadcastAll('availability:changed');
      // a switch for a basic harness, the tier or its tool channel changes what the picker lists
      live.acpAdmission?.emit();
      capsChanged();
      // a remote switch may turn a browser channel off (or back on)
      live.browserControl
        ?.configure(live.browserPrefs.channel)
        .then(() => broadcastAll('browser:channelChanged', chromeState()))
        // configure() handles a channel that fails to load itself
        .catch((error) => noteIgnored('apply a remote switch to the browser channel', error));
    },
  });
  registerFlags(ipcMain, flags);
  // the performance probe runs while its switch is on (electron/perf/probe.cjs)
  syncProbe(isEnabled('shared.perf.probe'), app.getPath('userData'), coreLoaded);
  // the cached switches may already have MoMo or Host off before any change is fetched
  recomputeMomoAccess();
  recomputeHostAccess();
  recomputePhoneAccess();
  return flags;
}

module.exports = { openFlags };
