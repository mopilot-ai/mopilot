// IPC for Reset MoMo (#2139): in main, one run at a time, MoMo is paused first, then every MoMo store is deleted (electron/momo/stores.cjs), and its settings go back to their defaults only once every registered store was deleted; what wasn't reset is said, a store this build has no way to reach included. Refused while MoMo is not allowed. Registers the folder defaults of MoMo's memory files and the sources hub's folder (<userData>/momo, electron/momo/stores.cjs momoDir); main's MoMo services (electron/app/momo.cjs) replace them with their own resets.
const path = require('node:path');
const { momoAllowed } = require('../../momo/access.cjs');
const { registerMomoStore, resetMomoStores, memoryFilesReset, folderReset, whileResetting, momoDir } = require('../../momo/stores.cjs');
const { resetMomoPrefs } = require('../../../shared/momoPrefs.mjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { noteIgnored } = require('../../ignored.cjs');

const SETTINGS = { id: 'settings', label: 'its settings' };

/**
 * @param {{ handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void }} ipcMain
 * @param {{ app: { getPath: (name: 'userData') => string }, readState: () => Record<string, any>,
 *           live: { patchPrefs?: (set: Record<string, unknown>) => boolean } }} deps
 * @param {{ allowed?: () => boolean, memoryDir?: string }} [o] for tests
 */
function register(ipcMain, { app, readState, live }, { allowed = momoAllowed, memoryDir = momoDir(app.getPath('userData')) } = {}) {
  registerMomoStore('memory', memoryFilesReset(memoryDir));
  registerMomoStore('sources', folderReset(path.join(memoryDir, 'sources')));
  registerMomoStore('connectors', folderReset(path.join(memoryDir, 'connectors')));
  /** prefs.momo as `next` makes it from what is saved now, written in the same step; false when it wasn't saved. */
  const write = (/** @type {(momo: unknown) => unknown} */ next) => live.patchPrefs?.({ momo: next(readState()?.prefs?.momo) }) === true;
  const pause = () => write((momo) => ({ ...(isJsonRecord(momo) ? momo : {}), paused: true }));
  async function run() {
    if (!allowed()) throw Object.assign(new Error('MoMo is not available.'), { code: 'not_allowed' });
    // nothing of MoMo's starts again while its data goes (routines and background reads check it)
    if (!pause()) throw Object.assign(new Error("Couldn't pause MoMo, so nothing was reset."), { code: 'save_failed' });
    /** @type {{ reset: { id: string, label: string }[], notReset: { id: string, label: string, reason: 'absent' | 'failed' }[] }} */
    const r = await resetMomoStores({ onError: (id, error) => noteIgnored(`reset MoMo's ${id}`, error) });
    // a store that couldn't be deleted keeps MoMo paused and its settings, so setup never shows over old data
    const failed = r.notReset.some((s) => s.reason === 'failed');
    if (!failed && write(resetMomoPrefs)) r.reset.push(SETTINGS);
    else r.notReset.push({ ...SETTINGS, reason: 'failed' });
    return r;
  }
  /** @type {Promise<unknown> | null} */
  let running = null;
  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  ipcMain.handle('momoReset:run', async () => {
    running ??= whileResetting(run).finally(() => {
      running = null;
    });
    try {
      return { value: await running };
    } catch (err) {
      return { error: { message: String(/** @type {any} */ (err)?.message ?? err), code: /** @type {any} */ (err)?.code ?? null } };
    }
  });
}

module.exports = { register };
