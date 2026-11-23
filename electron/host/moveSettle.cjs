// Holds what is sent to a chat while Switch host moves it, and lets it go when the move ends (done or refused): what was kept in the outbox goes to whichever Host owns the chat then. The hold has no timer of its own: it ends exactly when the move does, and the move is bounded by its own request timeouts (electron/host/continue.cjs), so the two cannot disagree and a message is never delivered to an owner that is mid-handover.
const { noteIgnored } = require('../ignored.cjs');
const { clock } = require('../platform/ports/clock.cjs');

/** One budget for the whole plan (the source's read, the target's folder check, what carrying would send): a stopped machine is reported in this long, not after each step has waited its own 15 s (Remote Run #5197). */
const PLAN_MS = 20_000;

/** @template T @param {Promise<T>} work @param {number} ms @returns {Promise<T>} `work`, or a `host_unreachable` refusal when it takes longer. */
function within(work, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = clock.setTimeout(() => reject(Object.assign(new Error('The machine did not answer.'), { code: 'host_unreachable' })), ms);
  });
  // the work goes on in the background after it is given up: its own failure is not an unhandled one
  work.catch((error) => noteIgnored('finish the Switch host plan after its deadline', error));
  return /** @type {Promise<T>} */ (Promise.race([work, late]).finally(() => clock.clearTimeout(timer)));
}

/** Per remote send service, the holds of each chat: how many (the dialog's plan, the continue, a second switch). @type {WeakMap<object, Map<string, { n: number }>>} */
const holdsOf = new WeakMap();
/** The plan hold of each chat that waits for the continue of the same dialog (the continue takes it over; the dialog's window ending releases it; there is no timer, the dialog owns the hold). Keyed by chat only: a Host turned off meanwhile still lets the continue find it. @type {Map<string, { hold: { end: () => Promise<void> }, off: () => void }>} */
const handovers = new Map();

/**
 * Takes a hold on the chat. The first one keeps what is sent to it, the last one to end lets it go to the owner the chat has then.
 * @param {{ chatId: string, remote: () => any, to?: string | null }} o `remote`: the remote send service (null while Host is off); `to`: the machine the chat moves to, for the rows' cause
 * @returns {{ end: () => Promise<void>, sending: any }}
 */
function acquire({ chatId, remote, to = null }) {
  const sending = remote();
  if (!sending) return { end: async () => undefined, sending: null };
  const holds = holdsOf.get(sending) ?? new Map();
  holdsOf.set(sending, holds);
  const h = holds.get(chatId) ?? { n: 0 };
  holds.set(chatId, h);
  if (h.n++ === 0) sending.holdMove(chatId, to);
  let ended = false;
  return {
    sending,
    async end() {
      if (ended) return;
      ended = true;
      if (--h.n > 0) return;
      holds.delete(chatId);
      try {
        await sending.endMove(chatId);
      } catch (e) {
        noteIgnored('send the messages kept for the old host to the new one', e);
      }
    },
  };
}

/**
 * The continue's hold: it takes over from the plan hold of the same dialog, so the chat is released when the move ends.
 * @param {{ chatId: string, remote: () => any, to?: string | null }} o
 * @returns {{ end: () => Promise<void> }}
 */
function holdMove(o) {
  const hold = acquire(o);
  const plan = handovers.get(o.chatId);
  if (plan) {
    handovers.delete(o.chatId);
    plan.off();
    void plan.hold.end();
  }
  return hold;
}

/** Calls `fn` once when the window that asked is gone: closed, crashed or navigated away (a committed main-frame navigation). Returns the way to stop watching. @param {any} sender @param {() => void} fn */
function onGone(sender, fn) {
  if (typeof sender?.once !== 'function') return () => undefined;
  const events = ['destroyed', 'render-process-gone', 'did-navigate'];
  for (const e of events) sender.once(e, fn);
  return () => {
    for (const e of events) sender.removeListener?.(e, fn);
  };
}

/** The dialog is closed or cancelled before its continue started: what it holds is released. @param {string} chatId */
async function releasePlan(chatId) {
  const plan = handovers.get(chatId);
  if (!plan) return;
  handovers.delete(chatId);
  plan.off();
  await plan.hold.end();
}

/**
 * The dialog owns the chat's hold from the press until it starts the continue (which takes the hold over) or ends: its plan failed, it asks the person something (they decide), or its window is gone. Between the plan's answer and the continue nothing can send to the chat's owner, and no timer decides when that ends.
 * @template T
 * @param {{ chatId: string, remote: () => any, to?: string | null, sender?: any }} o `sender`: the window that asked
 * @param {() => Promise<T>} plan
 * @returns {Promise<T>}
 */
async function holdPlan(o, plan) {
  const hold = acquire(o);
  // the window going away while the plan runs or while the hold waits for the continue releases it
  let gone = false;
  const off = onGone(o.sender, () => {
    gone = true;
    off();
    if (handovers.get(o.chatId)?.hold === hold) handovers.delete(o.chatId);
    void hold.end();
  });
  let out;
  try {
    out = await within(Promise.resolve().then(plan), PLAN_MS);
  } catch (e) {
    off();
    await hold.end();
    throw e;
  }
  // a plan asked again (another folder, another machine): the earlier one's hold goes now, so none outlives the move
  const earlier = gone ? undefined : handovers.get(o.chatId);
  if (earlier) {
    handovers.delete(o.chatId);
    earlier.off();
    void earlier.hold.end();
  }
  // the dialog asks only when there is a carry plan (SwitchHostDialog run)
  if (out?.plan || gone) {
    off();
    await hold.end();
  } else if (hold.sending) handovers.set(o.chatId, { hold, off });
  else off();
  return out;
}

/**
 * The window's `host:codePlan` handler: the plan under the dialog's hold, owned by the window that asked (`this.sender`, set by the IPC wrapper).
 * @param {{ remote: () => any, nameOf: (id: string) => string | null, plan: (req: any) => Promise<any> | any }} o
 */
function planHandler({ remote, nameOf, plan }) {
  return /** @this {{ sender?: any }} */ function (/** @type {any} */ req) {
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
    return holdPlan({ chatId: str(req?.chatId), remote, to: nameOf(str(req?.targetHostId)), sender: this?.sender }, () => plan(req));
  };
}

module.exports = { holdMove, holdPlan, releasePlan, planHandler, PLAN_MS };
