// Windows and Linux updates offer the published package in the browser, preserving the running app and active chats.
const { dialog, shell: systemShell } = require('../platform/ports/electronApi.cjs').api;
const shell = require('../capabilities/browser/userChrome.cjs').userShell(systemShell);
const { noteIgnored, messageOf } = require('../ignored.cjs');

/** What a ready state offers for the feed's update on Windows: its installer's address. */
const installerOffer = (update) => ({
  version: update.name,
  notes: update.notes,
  url: update.url,
  ...(update.rollback && { rollback: update.rollback }),
});

/**
 * Read the feed ourselves; a newer version is offered as an installer download.
 * @param {{ state: object, set: (patch: object) => unknown, current: (context: object) => boolean,
 *   authHeaders: (channel: string) => Promise<Record<string, string>>,
 *   readFeed: (context: object, headers: Record<string, string>) => Promise<{ url: string, name: string, notes: string } | null> }} updater
 *   the updater (electron/updates/updater.cjs)
 * @param {{ generation: number, channel: string }} context
 */
async function checkInstallerFeed(updater, context) {
  updater.set({ status: 'checking', error: null });
  try {
    const headers = await updater.authHeaders(context.channel);
    if (!updater.current(context)) return updater.state;
    const update = await updater.readFeed(context, headers);
    if (!updater.current(context)) return updater.state;
    if (!update) return updater.set({ status: 'idle', checkedAt: Date.now() }), updater.state;
    updater.set({ status: 'ready', available: installerOffer(update), checkedAt: Date.now() });
  } catch (e) {
    if (updater.current(context)) updater.set({ status: 'error', error: messageOf(e), checkedAt: Date.now() });
  }
  return updater.state;
}

/**
 * Open the installer's download in the browser; the app keeps running until it's run. When no browser opens, say so,
 * with the address to download it from by hand, unless the offer changed meanwhile (`current`).
 * @param {string} url
 * @param {() => boolean} current
 */
function openInstaller(url, current) {
  return shell.openExternal(url).then(
    () => true,
    async (error) => {
      if (!current()) {
        noteIgnored('open an obsolete update download', error);
        return false;
      }
      await dialog.showMessageBox({
        type: 'error',
        message: 'Could not open the update download',
        detail: `${messageOf(error)}\n\nDownload the update from:\n${url}`,
        buttons: ['OK'],
      });
      return false;
    },
  );
}

module.exports = { checkInstallerFeed, installerOffer, openInstaller };
