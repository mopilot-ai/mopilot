// IPC for MoMo's open loops (#2139 P4): the Memory tab's Open loops list and a nudge card's Done, Dismiss, Snooze and Reopen (loopActs.cjs); every change goes to the windows as momoMemory:changed. Refused while MoMo is not allowed; a store that can't be read (no encryption) says so.
const { messageOf } = require('../ignored.cjs');
const { NOT_ALLOWED } = require('./memoryIpc.cjs');

const CHANNELS = Object.freeze(['momoMemory:loops', 'momoMemory:loopAct']);
/** The closed loops the tab shows, newest closed first. */
const CLOSED_SHOWN = 20;

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ loops: InstanceType<typeof import('./openLoops.cjs').OpenLoopStore>, act: ReturnType<typeof import('./loopActs.cjs').createLoopActs>,
 *   allowed: () => boolean, broadcast?: ((channel: string) => void) | null }} o
 */
function registerLoopsIpc(ipcMain, { loops, act, allowed, broadcast = null }) {
  const changed = () => {
    if (allowed() === true) broadcast?.('momoMemory:changed');
  };
  loops.on('changed', changed);
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      try {
        return { ok: true, ...(await fn(...args)) };
      } catch (error) {
        const unavailable = /** @type {any} */ (error)?.code === 'unavailable';
        return { ok: false, error: messageOf(error), ...(unavailable ? { reason: 'unavailable' } : {}) };
      }
    });
  on('momoMemory:loops', () => {
    const all = loops.list();
    return {
      open: all.filter((l) => l.state === 'open'),
      closed: all
        .filter((l) => l.state !== 'open')
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
        .slice(0, CLOSED_SHOWN),
      now: Date.now(),
    };
  });
  on('momoMemory:loopAct', async (id, a) => ({ loop: await act(id, a) }));
  return () => {
    loops.off('changed', changed);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerLoopsIpc, CHANNELS, CLOSED_SHOWN };
