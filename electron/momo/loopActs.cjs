// What the user (or MoMo, asked by the user in its chat) can do to an open loop (#2139 P4): mark it done, dismiss it (which closes it and makes its kind come less often for 30 days), snooze it (a day, a week, or to a time) or open it again. One place for the Memory tab, a nudge's card and the momo_open_loops tool, so all three mean the same.
const { LoopError } = require('./openLoops.cjs');

const DAY = 86_400_000;
/** How long each snooze lasts. */
const SNOOZES = Object.freeze({ day: DAY, week: 7 * DAY });
const ACTIONS = Object.freeze(['done', 'dismiss', 'snooze', 'reopen']);

/**
 * @param {{ loops: InstanceType<typeof import('./openLoops.cjs').OpenLoopStore>, dismissed: (kind: string) => Promise<unknown> | unknown,
 *   now?: () => number }} o dismissed: the nudge check's (nudges.cjs), which spaces out that kind
 */
function createLoopActs({ loops, dismissed, now = Date.now }) {
  /**
   * @param {unknown} id
   * @param {{ action?: unknown, snooze?: unknown, until?: unknown }} a snooze: "day" or "week", or until: a time in ms
   */
  return async function act(id, a) {
    if (typeof id !== 'string' || !id) throw new LoopError('A loop id is needed', 'bad_args');
    const action = String(a?.action ?? '');
    if (!ACTIONS.includes(action)) throw new LoopError(`action is one of ${ACTIONS.join(', ')}`, 'bad_args');
    if (action === 'done') return loops.setState(id, 'done');
    if (action === 'reopen') return loops.setState(id, 'open');
    if (action === 'dismiss') {
      const loop = await loops.setState(id, 'dismissed');
      await dismissed(loop.kind);
      return loop;
    }
    const span =
      typeof a?.snooze === 'string' && Object.hasOwn(SNOOZES, a.snooze) ? SNOOZES[/** @type {'day' | 'week'} */ (a.snooze)] : null;
    const until = span !== null ? now() + span : a?.until;
    if (typeof until !== 'number' || !Number.isFinite(until) || until <= now())
      throw new LoopError('Snooze for a "day" or a "week", or until a time to come', 'bad_args');
    return loops.snooze(id, until);
  };
}

module.exports = { createLoopActs, SNOOZES, ACTIONS };
