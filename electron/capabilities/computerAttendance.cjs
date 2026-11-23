// Whether someone is at the computer for a computer-use call: the reason it counts as unattended, from the chat's turn, the helper's idle time, a remote owner (#1364) and the VM-only bench switch (#1600).
const { noteIgnored } = require('../ignored.cjs');
const { unattendedReason } = require('./contract/policy.cjs');
const { benchAttended: vmBenchAttended } = require('../platform/virtualMachine.cjs');

/**
 * The `unattended(chatId, ctx)` check computer use's tools ask before acting: null when the user counts as present,
 * else the reason (policy.cjs unattendedReason).
 * @param {{ helper: { idleSeconds(): Promise<number> }, sessions: { get(chatId: string): any },
 *   controller: { isSubagentCall(chatId: string, callId?: string | null): boolean }, remote?: { get(chatId: string): any } | null,
 *   kindOf: (chatId: string) => string, benchAttended?: () => Promise<boolean> }} o
 *   benchAttended: MOPILOT_BENCH_ATTENDED=1 inside a VM (electron/platform/virtualMachine.cjs); the idle time then counts as 0
 */
function attendance({ helper, sessions, controller, remote = null, kindOf, benchAttended = vmBenchAttended }) {
  return async (/** @type {string} */ chatId, /** @type {{ callId?: string | null } | undefined} */ ctx) => {
    const s = sessions.get(chatId);
    // a switch that can't be read is off: it never stands in for the idle check
    const switched = await Promise.resolve()
      .then(() => benchAttended())
      .catch((error) => {
        noteIgnored('read the bench switch for computer use', error);
        return false;
      });
    let idleMs = 0;
    try {
      // a remote owner's person is at its device (#1364): this Mac's idle time says nothing about them; a benchmark VM
      // with the bench switch counts as attended (#1600)
      idleMs = remote?.get(chatId) || switched ? 0 : (await helper.idleSeconds()) * 1000;
    } catch (error) {
      // idle time unknown: treat the user as present
      noteIgnored("read the user's idle time for computer use", error);
    }
    return unattendedReason({
      turn: s.activeTurn,
      scheduled: !!s.scheduled?.unattended,
      subagent: controller.isSubagentCall(chatId, ctx?.callId),
      idleMs,
      basic: kindOf(chatId).startsWith('acp'),
      promptActive: !!s.activeTurn,
    });
  };
}

module.exports = { attendance };
