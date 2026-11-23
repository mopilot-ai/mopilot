// The pending harness switch a ChatController settles before it starts a message's turn: the message is the first one on the
// new harness, carrying the handoff record, and a switch that cannot settle keeps its choice for the message's retry.
const { queueItem } = require('./queueItem.cjs');
const { carryInputGuard, inputIsGuarded, assertInputCurrent } = require('./contract/inputGuard.cjs');
const { matchesSource } = require('./contract/route.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */

/**
 * Settles the chat's pending switch `ps` for `item` (SwitchRunner.perform). `superseded()`: a Stop or a replacement turn
 * took the start over while the switch ran.
 * @param {ChatController} c
 * @returns {Promise<{ item: any, res?: { started: false, error: string } }>} the item with what the switch prepared; `res` when
 *   the message is not to be sent now (superseded, or the switch could not settle)
 */
async function settleSwitch(c, chatId, item, ps, superseded) {
  // the chip is gone once the message is on its way
  c.state.patch(chatId, { pendingSwitch: null });
  let ready = false;
  let retired = false;
  const check = () => {
    try {
      assertInputCurrent(item);
    } catch (error) {
      retired = true;
      throw error;
    }
  };
  // the segment left may run turns of its own while its history is read (a resumed Codex goal) or exit: they are not
  // this start's, and after the commit their end never comes, so they must not take its turn over (controllerEvents.cjs)
  const r = c.rt(chatId);
  /** @type {any} */ let from = null;
  try {
    from = c.ref(chatId);
    r.switchingFrom = from;
    const prep = await c.switcher.perform(chatId, ps, item.origin, inputIsGuarded(item) ? check : undefined);
    ready = !!prep?.ready;
    if (ready) {
      // The switch can finish after Stop: its prepared context still belongs to the queued retry.
      c.invalidate();
      const extra = {};
      // a prefix the message already carries (the issue a chat started from) stays after the switch's own; one that
      // already holds the switch's (a retry of this send) is kept as it is
      const own = item.opts?.prefix;
      if (prep.prefix) extra.prefix = !own ? prep.prefix : own.includes(prep.prefix) ? own : `${prep.prefix}\n\n${own}`;
      if (prep.note) extra.note = prep.note;
      item = carryInputGuard(item, { ...item, opts: { ...item.opts, ...extra } });
    }
    if (superseded()) return { item, res: { started: false, error: 'turn_changed' } };
    if (!ready)
      return { item, res: { started: false, error: prep?.error ?? 'The switch did not finish. Your message is kept in the queue.' } };
    // what the switch asked to send after the message (a goal set again): first in line
    if (Array.isArray(prep.after) && prep.after.length) {
      const later = prep.after.map((a) => queueItem({ text: a.text, attachments: [], opts: a.opts }, item.origin));
      c.state.patch(chatId, { queue: [...later, ...c.state.get(chatId).queue] });
    }
    return { item };
  } finally {
    // only this start's mark: another start that took the chat over meanwhile keeps its own
    if (from && r.switchingFrom === from) r.switchingFrom = null;
    // a current switch that did not settle (or threw) is still the user's choice: its queued message goes through it when
    // sent again, not to the harness they left (unless they changed their mind meanwhile)
    if (!ready && !retired && !ps.continue && !c.state.get(chatId).pendingSwitch) c.state.patch(chatId, { pendingSwitch: ps });
  }
}

/**
 * Whether a turn's start, end, progress or text (or its harness's exit) from `source` is the chat's: its selected session,
 * and not one a switch is leaving (settleSwitch above), whose own turns and exit never take over the switching start's turn.
 * @param {ChatController} c
 */
function turnSource(c, chatId, source) {
  if (!c.isCurrentSource(chatId, source)) return false;
  const from = c.rts?.get(chatId)?.switchingFrom;
  return !from || !matchesSource(from, source);
}

module.exports = { settleSwitch, turnSource };
