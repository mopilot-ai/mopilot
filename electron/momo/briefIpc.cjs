// IPC for the morning brief's Try again (A7): momoBrief:runNow writes the brief now, as the user's own request, through the brief's own run (the one the scheduler calls), so it is held by the same rules (MoMo allowed and not paused, the `momo.brief` flag, once a day, something to say) except quiet hours and the week away. Refused while MoMo is not allowed, unavailable while the flag is off. A refusal says why in words; a run that could not start is kept as the brief's failure for the Scheduled row. A change is told to the windows as momoTasks:changed.
const { messageOf } = require('../ignored.cjs');
const { RunSkipped } = require('../platform/scheduler.cjs');
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'unavailable', error: 'The morning brief is off' });

/** Why a brief did not go, in a line. */
const SKIPPED = Object.freeze({
  off: 'The morning brief is off.',
  paused: 'MoMo is paused. Resume it first.',
  'already-today': 'The brief already went out today.',
  'nothing-to-say': 'Nothing to tell you today.',
  'at-limit': 'MoMo’s brain is at its limit.',
  'previous-running': 'A brief is being written.',
  'not-allowed': 'MoMo is not available.',
});

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ allowed: () => boolean, enabled: () => boolean, run: () => Promise<unknown>, failed: (error: unknown) => Promise<unknown>,
 *   broadcast: (channel: string) => void }} o
 * @returns {() => void}
 */
function registerBriefIpc(ipcMain, { allowed, enabled, run, failed, broadcast }) {
  ipcMain.handle('momoBrief:runNow', async () => {
    if (allowed() !== true) return NOT_ALLOWED;
    if (enabled() !== true) return UNAVAILABLE;
    try {
      await run();
      broadcast('momoTasks:changed');
      return { ok: true };
    } catch (error) {
      if (error instanceof RunSkipped)
        return { ok: false, reason: 'skipped', error: SKIPPED[/** @type {keyof typeof SKIPPED} */ (error.reason)] ?? 'No brief now.' };
      // it could not start: the Scheduled row says why, with Try again
      await failed(error);
      broadcast('momoTasks:changed');
      return { ok: false, error: messageOf(error) };
    }
  });
  return () => ipcMain.removeHandler('momoBrief:runNow');
}

module.exports = { registerBriefIpc, SKIPPED, NOT_ALLOWED, UNAVAILABLE };
