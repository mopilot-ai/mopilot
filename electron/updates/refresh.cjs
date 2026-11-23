// Ready update refresh preserves version ordering unless explicit rollback authority supersedes the prepared package.
const { app } = require('../platform/ports/electronApi.cjs').api;
const { compareVersions } = require('../harness/versions.cjs');
const { installerOffer } = require('./windows.cjs');
const { parseExactVersion } = require('../../shared/exactSemver.mjs');

/** A newer published update or an explicit rollback replaces a ready artifact without flashing a new check. */
async function refreshUpdate(updater) {
  const staged = updater.state.available;
  if (updater.refreshing || updater.installWork || updater.nativeOperation || !staged || !parseExactVersion(staged.version))
    return updater.state;
  if (!updater.manual && !app.isInApplicationsFolder()) return updater.state;
  const context = updater.context();
  const live = () => updater.current(context) && updater.state.available === staged && !updater.installWork;
  updater.refreshing = true;
  try {
    const headers = await updater.authHeaders(context.channel);
    const update = live() ? await updater.readFeed(context, headers) : null;
    if (!update || !live()) return updater.state;
    if (update.rollback) {
      if (update.name === staged.version && update.rollback.requestId === staged.rollback?.requestId) return updater.state;
    } else if (compareVersions(update.name, staged.version) <= 0) return updater.state;
    if (!updater.manual) return updater.startDownload(context, update, headers), updater.state;
    updater.set({ available: installerOffer(update), error: null, checkedAt: Date.now() });
  } finally {
    updater.refreshing = false;
  }
  return updater.state;
}

module.exports = { refreshUpdate };
