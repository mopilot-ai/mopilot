// Record a skill's wiring in main: one recorder and its pill per app, and the computer:record* channels the composer uses (start a recording for a chat, its state, Discard) with the events it hears back (computer:recordDone with the recording's block for that chat's composer, computer:recordChanged).
const { WatchRecorder } = require('./watchRecord.cjs');
const { RecordPill } = require('./watchRecordPill.cjs');

/**
 * @param {object} o
 * @param {{ handle(channel: string, fn: (...a: any[]) => any): void }} o.ipcMain
 * @param {{ BrowserWindow: any, screen: any } | null} o.electron
 * @param {any} o.helper the computer-use helper
 * @param {(channel: string, payload: any) => void} o.broadcast to every window
 * @param {(what: string, error: unknown) => void} o.note where an error that is survived is noted
 */
function setupWatchRecord({ ipcMain, electron, helper, broadcast, note }) {
  /** @type {InstanceType<typeof WatchRecorder>} */
  let recorder;
  const pill = new RecordPill({ electron, onDone: () => void recorder.done(), onDiscard: () => void recorder.discard(), note });
  /** the window that started the recording: the only one whose composer gets it */
  /** @type {any} */
  let owner = null;
  recorder = new WatchRecorder({
    helper,
    pill,
    onDone: (result) => {
      if (owner && !owner.isDestroyed?.()) owner.send('computer:recordDone', result);
      else broadcast('computer:recordDone', result);
    },
    onChange: () => broadcast('computer:recordChanged', recorder.state),
    note,
  });
  ipcMain.handle('computer:recordStart', async (e, chatId) => {
    if (typeof chatId !== 'string' || !chatId) return { ok: false, error: 'No chat to record for' };
    const started = await recorder.start(chatId);
    if (started.ok) owner = e?.sender ?? null;
    return started;
  });
  ipcMain.handle('computer:recordState', () => recorder.state);
  ipcMain.handle('computer:recordDiscard', () => recorder.discard());
  return {
    recorder,
    /** The app is closing: a recording in progress is dropped and the pill goes. */
    async dispose() {
      await recorder.dispose();
      pill.dispose();
    },
  };
}

module.exports = { setupWatchRecord };
