// MoMo's system notification (#2139): "MoMo needs you" (an approval or question in a MoMo chat), through the app's one Notifier as its 'momo' kind. It says only a fixed title (shared/momoNotices.mjs), so nothing personal reaches the lock screen; none shows while MoMo is off for the account or in quiet hours (a "needs you" that came then is said once when they end); clicking one opens that MoMo chat. A notice may name the card the user must answer (`cardId`), which a phone's push carries so a tap opens MoMo at that card; a card answered or gone by the time the notice is said is left out.

const { MOMO_NOTICE_TITLES } = require('../../shared/momoNotices.mjs');
const { routineSettings, inQuietHours } = require('../../shared/momoRoutine.mjs');
const { acpFormCardId } = require('../../shared/panelCardIds.mjs');

/** Every MoMo notice's key in the Notifier starts with it, so no chat id can be one. */
const PREFIX = 'momo:';
/** Notices remembered for their click, and "needs you" notices kept through quiet hours: the oldest goes past this many. */
const KEEP = 200;
/** How often a "needs you" kept through quiet hours checks whether they ended. */
const QUIET_CHECK_MS = 60_000;

/** @typedef {{ kind: 'chat', chatId: string, cardId?: string }} MomoTarget `cardId`: the approval or question the user must answer, when one is named */

const ok = (/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0 && id.length <= 256;

/** The chat a notice opens and the card it names (when a valid one), with nothing else it was given, or null when it names no chat. @returns {MomoTarget | null} */
function targetOf(/** @type {any} */ t) {
  if (t?.kind !== 'chat' || !ok(t.chatId)) return null;
  return { kind: 'chat', chatId: t.chatId, ...(ok(t.cardId) && { cardId: t.cardId }) };
}

const keyOf = (/** @type {MomoTarget} */ t) => `${PREFIX}${t.kind}:${t.chatId}`;

/** The chat a MoMo notice's key names (the inverse of keyOf, which is what the push hook is given as the banner's chat), or null for a key that is not one. @returns {string | null} */
const chatOfKey = (/** @type {unknown} */ key) => {
  const head = `${PREFIX}chat:`;
  return typeof key === 'string' && key.startsWith(head) && key.length > head.length ? key.slice(head.length) : null;
};

/** Whether MoMo needing an answer notifies, as saved (prefs.momo.notify), on unless the user turned it off (shared/momoPrefs.mjs, #2196). */
const notifies = (/** @type {any} */ prefs) => prefs?.momo?.notify?.needsAnswer !== false;

/**
 * @param {object} o
 * @param {{ notify(kind: string, key: string, opts: object): unknown, notice(n: { title: string, body: string }): void, clear(key: string): void, clearMatching(match: (key: string) => boolean): void }} o.notifier the app's Notifier
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account (the gate, electron/momo/access.cjs)
 * @param {() => unknown} o.prefs the app's prefs (prefs.momo: notify switches, quiet hours)
 * @param {(target: MomoTarget) => void} o.open opens the MoMo chat
 * @param {(target: MomoTarget) => boolean} [o.viewing] the user has that chat open (no banner while the app is focused)
 * @param {(chatId: string, cardId: string) => boolean} [o.cardUp] the card is still up in the chat: one answered or gone is not named
 * @param {(chatId: string) => string | null} [o.channelOf] the open channel a chat is the journal of (A2), null for main and any other chat: a phone's push names it by an opaque handle, so a tap opens that channel
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule] a timer (setTimeout)
 * @param {(timer: any) => void} [o.cancel] its cancel (clearTimeout)
 */
function createMomoNotices({
  notifier,
  allowed,
  prefs,
  open,
  viewing = () => false,
  cardUp = () => true,
  channelOf = () => null,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms).unref(),
  cancel = clearTimeout,
}) {
  /** @type {Map<string, MomoTarget>} notices that may still be on screen, by key */
  const known = new Map();
  /** @type {Map<string, MomoTarget>} "needs you" notices that came in quiet hours, still unanswered, by key */
  const pending = new Map();
  /** @type {unknown} the check for the end of quiet hours, while something is pending */
  let timer = null;

  /** Remembers `value` at `key` as the newest, keeping at most KEEP. */
  const remember = (/** @type {Map<string, MomoTarget>} */ map, /** @type {string} */ key, /** @type {MomoTarget} */ value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > KEEP) map.delete(map.keys().next().value);
  };
  const stopWaiting = () => {
    pending.clear();
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const waitForQuietEnd = () => {
    timer ??= schedule(quietCheck, QUIET_CHECK_MS);
  };
  /** The target without its card once that card was answered or went away (a notice kept through quiet hours, a late click). */
  const current = (/** @type {MomoTarget} */ t) => {
    if (t.cardId === undefined || cardUp(t.chatId, t.cardId)) return t;
    return { kind: t.kind, chatId: t.chatId };
  };

  /** Quiet hours may have ended: one "MoMo needs you" for what is still waiting, opening the newest. */
  function quietCheck() {
    timer = null;
    const p = prefs();
    if (!allowed() || !notifies(p)) return stopWaiting();
    if (inQuietHours(routineSettings(p).quietHours, now())) return waitForQuietEnd();
    const newest = [...pending.values()].at(-1);
    stopWaiting();
    post(/** @type {MomoTarget} */ (newest));
  }

  /** @returns {boolean} whether it showed */
  function show(/** @type {unknown} */ item) {
    const target = targetOf(item);
    if (!target || !allowed()) return false;
    const p = prefs();
    if (!notifies(p)) return false;
    if (inQuietHours(routineSettings(p).quietHours, now())) {
      // it waits for quiet hours to end
      remember(pending, keyOf(target), target);
      waitForQuietEnd();
      return false;
    }
    return post(target);
  }

  /** @param {MomoTarget} target */
  function post(target) {
    target = current(target);
    const key = keyOf(target);
    remember(known, key, target);
    const channelId = channelOf(target.chatId);
    // the title alone: no body, and no chat title for a merged one to list
    const shown = notifier.notify('momo', key, {
      title: MOMO_NOTICE_TITLES.needsYou,
      body: '',
      chatTitle: '',
      status: 'needs',
      viewing: viewing(target) === true,
      ...(target.cardId !== undefined && { cardId: target.cardId }),
      ...(channelId && { channelId }),
    });
    return shown != null;
  }

  return {
    /** MoMo needs the user: an approval or a question in a MoMo chat ({kind: 'chat'}), naming the card when its caller knows it. */
    needsYou: (/** @type {MomoTarget} */ target) => show(target),
    /**
     * Setup's Notifications row (#2607): MoMo's notices are on, said once as a notice the person asked for, which is also
     * how macOS asks for notification permission. Nothing shows while Notifications is Never.
     */
    welcome() {
      notifier.notice({ title: 'MoMo notifications are on', body: 'You’ll hear from MoMo when it needs you.' });
      return true;
    },
    /** The chat's question was answered or seen: its notice goes. */
    resolved(/** @type {MomoTarget} */ target) {
      const t = targetOf(target);
      if (!t) return;
      known.delete(keyOf(t));
      pending.delete(keyOf(t));
      if (!pending.size) stopWaiting();
      notifier.clear(keyOf(t));
    },
    /**
     * A notification was clicked (the Notifier's onClick): true when it was MoMo's, which opens the MoMo chat it names
     * while MoMo is still on. Main's chat opener takes the rest.
     */
    click(/** @type {unknown} */ key) {
      if (typeof key !== 'string' || !key.startsWith(PREFIX)) return false;
      const target = known.get(key);
      known.delete(key);
      if (target && allowed()) open(current(target));
      return true;
    },
    /** MoMo went off for the account: every MoMo notice the Notifier has goes, and nothing waits for quiet hours to end. */
    closeAll() {
      known.clear();
      stopWaiting();
      notifier.clearMatching((key) => key.startsWith(PREFIX));
    },
  };
}

/**
 * Whether the card `cardId` is still up in the chat main holds (its approvals, and its ACP questions still pending, as
 * shared/panelCardIds.mjs names them): false once it was answered, withdrawn or its turn ended, and for no chat state.
 * @param {{ has?: (chatId: string) => boolean, get: (chatId: string) => { approvals?: { id: unknown }[], questions?: { id: unknown, status?: string }[] } } | null | undefined} state
 */
function cardUp(state, /** @type {string} */ chatId, /** @type {string} */ cardId) {
  if (!state || state.has?.(chatId) === false) return false;
  const s = state.get(chatId);
  if (s?.approvals?.some((a) => String(a.id) === cardId)) return true;
  return !!s?.questions?.some((q) => q.status === 'pending' && acpFormCardId(String(q.id)) === cardId);
}

module.exports = { createMomoNotices, cardUp, chatOfKey, PREFIX, KEEP, QUIET_CHECK_MS };
