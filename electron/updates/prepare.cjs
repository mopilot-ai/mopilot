// Turns a finished macOS download into a staged artifact on one native installer for the life of the app.
const { fs } = require('../platform/ports/fs.cjs');
const { app, autoUpdater } = require('../platform/ports/electronApi.cjs').api;
const { ignoring, messageOf, noteIgnored } = require('../ignored.cjs');
const { serveUpdate } = require('./download.cjs');
const { preparedUpdateLine } = require('../../shared/updatePreparation.cjs');

const PREPARE_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 60_000;

async function prepareDownload(updater, context, file, update, signal) {
  if (updater.macInstaller) {
    updater.set({ preparing: true });
    const stage = await updater.macInstaller.prepare(file, update.name, signal, (lost, error) => {
      if (updater.disposed || updater.stagedArtifact?.stage !== lost) return;
      const installing = updater.state.status === 'installing';
      updater.stagedArtifact = null;
      if (installing) return updater.installFailed(messageOf(error));
      if (updater.state.status === 'downloading') return updater.set({ available: null });
      updater.stopIdleWait();
      updater.set({ status: 'error', available: null, error: messageOf(error), restartWhenIdle: false });
    });
    if (!updater.current(context)) return stage.cancel();
    await fs.promises
      .rm(updater.downloadDir(), { recursive: true, force: true })
      .catch(ignoring('remove a zip the macOS installer unpacked'));
    if (!updater.current(context)) return stage.cancel();
    if (!stage.ready()) throw new Error('The update installer stopped. Check for updates to try again.');
    updater.stagedArtifact?.stage?.cancel();
    updater.stagedArtifact = {
      channel: context.channel,
      available: { version: update.name, notes: update.notes || '', ...(update.rollback && { rollback: update.rollback }) },
      valid: true,
      stage,
    };
    updater.set({ ...updater.stagedState(), checkedAt: Date.now() });
    console.info(preparedUpdateLine(update.name));
    return;
  }

  const served = await (updater.o.serve ?? serveUpdate)({
    file,
    update: { name: update.name, notes: update.notes, pub_date: update.pub_date },
  });
  if (!updater.current(context)) return updater.closeFeed(served);
  if (updater.nativeOperation) {
    updater.closeFeed(served);
    throw new Error('A previous update check is still finishing. Try again after it finishes, or restart MoPilot.');
  }
  updater.served = served;
  try {
    autoUpdater.setFeedURL({ url: served.feedUrl, serverType: 'json' });
  } catch (error) {
    updater.closeFeed(served);
    throw error;
  }
  const operation = { ...context, timedOut: false, rollback: update.rollback };
  updater.nativeOperation = operation;
  updater.set({ preparing: true });
  updater.nativeTimeout = setTimeout(() => {
    if (updater.nativeOperation !== operation || updater.disposed) return;
    operation.timedOut = true;
    updater.settle({ status: 'error', error: 'Preparing the update timed out. Restart MoPilot to check again.' }, true);
  }, PREPARE_TIMEOUT_MS);
  updater.nativeTimeout.unref?.();
  try {
    autoUpdater.checkForUpdates();
  } catch (error) {
    updater.finishNative({ status: 'error', error: messageOf(error) });
  }
}

/** Transfers a valid stage. The child still waits for the actual exit before activation. */
async function commitPreparedUpdate(updater, restart) {
  const artifact = updater.stagedArtifact;
  if (!artifact?.stage || !artifact.valid || artifact.channel !== updater.channel) {
    if (restart) throw new Error('The prepared update is no longer available. Check for updates to try again.');
    return;
  }
  if (!restart) updater.o.activationAttempt?.(artifact.available.version, artifact.channel);
  await artifact.stage.commit(restart);
  if (restart) updater.o.activationAttempt?.(artifact.available.version, artifact.channel);
}

/** Restart is already approved. Keep the app open until the native helper has the activation command. */
async function restartUpdate(updater) {
  updater.set({ status: 'installing', error: null });
  clearTimeout(updater.installTimer);
  updater.installTimer = setTimeout(() => updater.installFailed('The restart to update did not finish. Try again.'), INSTALL_TIMEOUT_MS);
  updater.installTimer.unref?.();
  try {
    if (updater.macInstaller) {
      updater.activating = commitPreparedUpdate(updater, true);
      await updater.activating;
      app.quit();
    } else autoUpdater.quitAndInstall();
  } catch (error) {
    if (updater.macInstaller) {
      noteIgnored('begin the prepared update restart', error);
      updater.installFailed('Could not start the update. Check for updates to try again.');
    } else updater.installFailed(messageOf(error));
    return false;
  } finally {
    updater.activating = null;
  }
  return true;
}

module.exports = { prepareDownload, commitPreparedUpdate, restartUpdate };
