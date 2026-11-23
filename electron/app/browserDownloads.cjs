// Where a download in a browser panel session goes (an agent's tab: its chat's folder; else the user's choice), which page's navigation turned into it, and the pane's Downloads list that follows it.
const { freeDownloadPath, reserveDownloadPath } = require('../capabilities/browser/downloadName.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { noteDownload } = require('../capabilities/browser/downloadNavigations.cjs');
const { DownloadList } = require('../capabilities/browser/downloadList.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');

/**
 * The user's downloads folder. Windows names it through its known-folder API (FOLDERID_Downloads), which fails when that
 * folder isn't there (Electron then throws "Failed to get 'downloads' path"), and every download from the pane was
 * cancelled with nothing said. There it falls back to Downloads in the user's home, where the known folder sits by
 * default, made private if missing. (Chromium's own fallback is Documents\Downloads, GetUserDownloadsDirectorySafe in
 * chrome_paths_win.cc.) Only that one folder is made: a home that is not an absolute path to a folder (a profile moved or
 * deleted) is not rebuilt, and the error goes to the caller, which then cancels the download as before.
 * @param {{ getPath: (name: 'downloads') => string }} app @param {() => string} home asked only when the fallback is needed
 */
function userDownloads(app, home) {
  try {
    return app.getPath('downloads');
  } catch (error) {
    noteIgnored("find the system's downloads folder", error);
    const base = home();
    if (!path.isAbsolute(base) || !fs.statSync(base, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`There is no home folder to keep downloads in (${JSON.stringify(base)}).`);
    const dir = path.join(base, 'Downloads');
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (made) {
      // one made meanwhile, or already there: a folder will do
      if (/** @type {NodeJS.ErrnoException} */ (made).code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw made;
    }
    return dir;
  }
}

/**
 * @param {{ app: { getPath: (name: 'downloads') => string }, session: { fromPartition: (p: string) => any }, partition: string, home?: () => string,
 *           tabs: () => { download: (item: any, wc: any) => string | null } | null | undefined,
 *           ipcMain?: Pick<Electron.IpcMain, 'handle'>, shell?: any, broadcast?: (channel: string, payload: any) => void }} o
 *   partition: the shared profile's (a chat's own partition hooks onBrowserDownload itself); tabs: the agent tabs' host;
 *   ipcMain, shell, broadcast: the Downloads list's (downloadList.cjs), none in tests that look only at where a file goes;
 *   home: the user's home, asked only when the downloads folder falls back (userDownloads), so it can't fail at startup
 */
function browserDownloads({ app, session, partition, tabs, ipcMain, shell, broadcast, home = os.homedir }) {
  /* Downloads from browser tabs go to the chosen folder, or ask each time. */
  let hooked = false;
  /** @type {{ dir: string | null, ask: boolean }} */
  let prefs = { dir: null, ask: false };
  const folder = () => prefs.dir || userDownloads(app, home);
  const list = broadcast ? new DownloadList({ broadcast, shell, folder }) : null;
  if (list && ipcMain) list.register(ipcMain);
  /** A download in a browser panel session (the shared profile or a chat's own). */
  function onBrowserDownload(/** @type {unknown} */ _e, /** @type {any} */ item, /** @type {any} */ wc) {
    // the page's navigation that became this download is no failed load (#1484)
    noteDownload(wc, item.getURLChain?.() ?? [item.getURL?.()]);
    try {
      // a tab an agent is driving saves into its chat's downloads folder (nobody would answer a dialog)
      const agentFile = tabs()?.download(item, wc);
      if (agentFile) item.setSavePath(agentFile);
      // Electron shows the save sheet: in the chosen folder, prefilled with a free name ("report (2).csv"), as the Codex app's is
      else if (prefs.ask) item.setSaveDialogOptions({ defaultPath: freeDownloadPath(folder(), item.getFilename()) });
      // never over an existing file: "report (1).pdf", like Chromium
      else item.setSavePath(reserveDownloadPath(folder(), item.getFilename(), item));
      // the pane lists it (Cancel on the save sheet leaves it Stopped) and peeks in the pane showing its page
      list?.track(item, { pageId: wc?.id, agent: !!agentFile });
    } catch (error) {
      // where it would go couldn't be decided: cancelled at this event, never redirected (and not listed)
      noteIgnored('save a browser download', error);
      item.cancel();
    }
  }
  /** @param {string | null} dir @param {boolean} ask */
  function setupDownloads(dir, ask) {
    prefs = { dir, ask };
    if (hooked) return;
    hooked = true;
    session.fromPartition(partition).on('will-download', onBrowserDownload);
  }
  return { onBrowserDownload, setupDownloads, list };
}

module.exports = { browserDownloads };
