// IPC for importing another browser's data into the built-in browser (Settings → Browser, the pane's menu and its first-run card): what can be imported, a job in two steps, cancel, what came in and removing it.
const { prefixCodePoints } = require('../../../shared/textPrefix.mjs');
const path = require('node:path');
const { ImportError, classify } = require('../../capabilities/browser/import/errors.cjs');

const FULL_DISK_ACCESS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/** A rejected import step as data (an IPC rejection loses the error's code): { ok: false, code, message }. */
async function settle(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (error) {
    const e = classify(error);
    return { ok: false, code: e.code, message: e.message };
  }
}

const text = (v, max = 200) => (typeof v === 'string' ? prefixCodePoints(v, max) : '');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ importer: () => InstanceType<typeof import('../../capabilities/browser/import/importer.cjs').BrowserImporter>, enabled: () => boolean, openExternal: (url: string) => Promise<void>, chooseFile: (sender: any) => Promise<string | null>, trash: (file: string) => Promise<void> }} deps
 *   importer: the importer, built on first use
 *   enabled: the shared.browser.import switch
 *   chooseFile: asks the user for the passwords file Safari exported (an open panel); null when they cancel
 *   trash: moves a file to the Trash
 */
function register(ipcMain, { importer, enabled, openExternal, chooseFile, trash }) {
  const guard =
    (fn) =>
    async (_e, ...args) =>
      settle(async () => {
        if (!enabled()) throw new ImportError('unsupported', 'Importing from another browser is turned off.');
        return fn(...args);
      });
  ipcMain.handle('browser:import:sources', () => (enabled() ? importer().sources() : []));
  ipcMain.handle(
    'browser:import:start',
    guard(async (req) =>
      importer().start({
        source: text(req?.source),
        profile: text(req?.profile),
        kinds: {
          bookmarks: !!req?.kinds?.bookmarks,
          history: !!req?.kinds?.history,
          cookies: !!req?.kinds?.cookies,
          passwords: !!req?.kinds?.passwords,
        },
      }),
    ),
  );
  ipcMain.handle(
    'browser:import:run',
    guard(async (req) => ({
      results: await importer().run({
        jobId: text(req?.jobId),
        sites: Array.isArray(req?.sites) ? req.sites.slice(0, 5000).map((s) => text(s)) : [],
      }),
    })),
  );
  ipcMain.handle('browser:import:cancel', (_e, jobId) => importer().cancel(text(jobId)));
  ipcMain.handle('browser:import:imported', () => importer().imported());
  ipcMain.handle('browser:import:removeCookies', (_e, site) => importer().removeCookies(site ? text(site) : undefined));
  ipcMain.handle('browser:import:deleteHistory', (_e, source) => importer().deleteHistory(source ? text(source) : undefined));
  ipcMain.handle('browser:import:deleteBookmarks', (_e, source) => importer().deleteBookmarks(source ? text(source) : undefined));
  ipcMain.handle('browser:import:deletePasswords', (_e, source) => importer().deletePasswords(source ? text(source) : undefined));
  ipcMain.handle('browser:import:openFullDiskAccess', () => openExternal(FULL_DISK_ACCESS));
  // the path stays in main: the dialog only learns the file's name
  ipcMain.handle('browser:import:choosePasswordFile', async (e) => {
    if (!enabled()) return null;
    const file = await chooseFile(e.sender);
    if (!file) return null;
    importer().setPasswordFile(file);
    return { name: path.basename(file) };
  });
  // the export holds every password in plain text: once imported, the user may send it to the Trash
  ipcMain.handle('browser:import:trashPasswordFile', async () =>
    settle(async () => {
      const file = importer().passwordFile;
      if (!file) throw new ImportError('no_file', 'No passwords file was chosen.');
      await trash(file);
      importer().setPasswordFile(null);
      return {};
    }),
  );
}

module.exports = { register, registeredBy: 'browser', settle, FULL_DISK_ACCESS };
