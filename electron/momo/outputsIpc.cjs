// IPC for the Outputs section of MoMo's right panel (#2139, src/components/momo/MomoOutputs.tsx): the saved files with their state, and the user's own clicks on one: Open (the default app, through shell.openPath on the path the store checked is a plain file in MoMo's folder), Show in Finder, Save a copy (main's save dialog over the asking window; the renderer never picks a path) and Delete. A click is the user's act, so none asks a card; nothing here makes a file or sends one anywhere.
const { fs } = require('../platform/ports/fs.cjs');
const { messageOf } = require('../ignored.cjs');

const CHANNELS = Object.freeze([
  'momoOutputs:list',
  'momoOutputs:open',
  'momoOutputs:reveal',
  'momoOutputs:saveCopy',
  'momoOutputs:remove',
]);
const NOT_ALLOWED = Object.freeze({ ok: false, error: 'MoMo is not available' });
const OFF = Object.freeze({ ok: false, error: 'Saving files is turned off' });
const GONE = 'The file is no longer there';

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ store: InstanceType<typeof import('./outputs.cjs').OutputsStore>, allowed: () => boolean, enabled: () => boolean,
 *           openPath: (path: string) => Promise<string>, reveal: (path: string) => void,
 *           pickCopy: (event: Electron.IpcMainInvokeEvent, name: string) => Promise<string | null>,
 *           broadcast: (channel: string) => void }} o
 *   openPath: Electron's shell.openPath (resolves an error text, '' when it opened); reveal: shell.showItemInFolder;
 *   pickCopy: main's save dialog over the window that asked (the path picked, null when cancelled)
 */
function registerOutputsIpc(ipcMain, { store, allowed, enabled, openPath, reveal, pickCopy, broadcast }) {
  const changed = () => {
    if (allowed() === true && enabled() === true) broadcast('momoOutputs:changed');
  };
  const off = store.onChange(changed);
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      // the momo.outputs flag is off: the panel shows no Outputs, and main answers none of its calls
      if (enabled() !== true) return OFF;
      try {
        return { ok: true, ...(await fn(e, ...args)) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });
  const pathOf = (/** @type {unknown} */ id) => {
    const p = typeof id === 'string' ? store.pathOf(id) : null;
    if (!p) throw new Error(GONE);
    return p;
  };
  on('momoOutputs:list', () => ({
    files: store
      .list()
      .map(({ id, name, type, size, at, note, fromPrivate, gone }) => ({ id, name, type, size, at, note, fromPrivate, gone })),
  }));
  on('momoOutputs:open', async (_e, id) => {
    const failed = await openPath(pathOf(id));
    if (failed) throw new Error(`Couldn’t open the file: ${failed}`);
    return {};
  });
  on('momoOutputs:reveal', (_e, id) => (reveal(pathOf(id)), {}));
  on('momoOutputs:saveCopy', async (e, id) => {
    const from = pathOf(id);
    const name = /** @type {{ name: string }} */ (store.list().find((f) => f.id === id)).name;
    const to = await pickCopy(e, name);
    if (!to) return { cancelled: true };
    await fs.promises.copyFile(from, to);
    return { cancelled: false };
  });
  on('momoOutputs:remove', async (_e, id) => ({ removed: typeof id === 'string' && (await store.remove(id)) }));
  return () => {
    off();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerOutputsIpc, CHANNELS, OFF };
