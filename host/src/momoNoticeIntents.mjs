// What a person's taps on a notice do on MoMo's home (the notice lane of the intent table, shared/momoIntents.mjs): "Not needed" and the signal choices are kept as reactions the home derived from its own decision log (the input of learned rules, never a client's description of the mail), "hide" on a brief offer is remembered, and the notice settings go to MoMo's prefs after their keys and types are checked.
import { decisionIdOf } from '../../shared/momoNotice/views.ts';
import { IntentError } from '../../shared/momoHomeApi.mjs';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The settings a screen may change, and how each is checked. */
const SETTINGS = {
  briefOn: (/** @type {unknown} */ v) => typeof v === 'boolean',
  briefTime: (/** @type {unknown} */ v) => typeof v === 'string' && CLOCK.test(v),
  quietFrom: (/** @type {unknown} */ v) => typeof v === 'string' && CLOCK.test(v),
  quietTo: (/** @type {unknown} */ v) => typeof v === 'string' && CLOCK.test(v),
  dailyCap: (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= 50,
  previews: (/** @type {unknown} */ v) => typeof v === 'boolean',
};

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoNoticeStore.mjs').createNoticeStore>} o.store
 * @param {{ prefs: { change: (patch: any) => Promise<unknown> } }} o.home
 * @param {() => number} [o.now]
 * @param {() => string[]} [o.signalIds] the ids of the signals MoMo shows now (the learning service's); none while it has none
 * @param {(key: unknown) => Promise<unknown>} [o.draft] writes a reply draft for a notice
 * @param {(key: unknown) => Promise<unknown>} [o.remind] sets a reminder on a matter
 * @param {(id: string) => boolean} [o.offerShown] whether the id is an offer on a brief MoMo showed
 */
export function createNoticeIntents({
  store,
  home,
  now = Date.now,
  signalIds = () => [],
  offerShown = () => false,
  remind = async () => ({ remindAt: '' }),
  draft = async () => ({ id: '' }),
}) {
  const CHANGED = 'This changed since you saw it.';
  const GONE = 'MoMo no longer has that notice.';
  /** A signal choice: only for a signal MoMo shows now, and the first choice stands. @param {'signal_make' | 'signal_ignore'} kind @param {unknown} id */
  const react = async (kind, id) => {
    const rowId = needId(id);
    if (!signalIds().includes(rowId)) throw new IntentError(GONE);
    if (store.reactions().some((/** @type {any} */ r) => r.rowId === rowId && (r.kind === 'signal_make' || r.kind === 'signal_ignore')))
      return;
    await store.addReaction({ kind, rowId, matterKey: null, decidedBy: null, outcome: null, fromDomain: null, at: now() });
  };
  /** @param {unknown} id */
  const needId = (id) => {
    if (typeof id !== 'string' || id === '' || id.length > 1100) throw new IntentError('That is not something MoMo can do.');
    return id;
  };
  return {
    /** "Not needed" on a notice: the matter is let go, and what MoMo knew of the notice (its rule or model, the sender's domain) is kept as the reaction. */
    'row.notNeeded': async (/** @type {{ rowId: string, decisionId?: string }} */ { rowId, decisionId }) => {
      const id = needId(rowId);
      const decision = store.decisions().findLast((/** @type {any} */ d) => d.changeId === id || d.matterKey === id);
      if (!decision) throw new IntentError(GONE);
      // a tap on an older state of a matter that has since moved on is refused: it must not dismiss what the owner has not seen
      const latest = store.decisions().findLast((/** @type {any} */ d) => d.matterKey === decision.matterKey);
      if (latest.changeId !== decision.changeId || (decisionId !== undefined && decisionId !== decisionIdOf(latest)))
        throw new IntentError(CHANGED);
      // let go atomically on the record as it is now: two taps at once change it once, and only the one that changed it is a reaction
      /** @type {any} */
      let ended = null;
      const changed = await store.notice.updateMatter(decision.matterKey, (/** @type {any} */ current) => {
        if (!current || current.state === 'dismissed') return undefined;
        ended = current;
        const { nextCheck: _a, pendingDelivery: _b, remindAt: _c, ...rest } = current;
        return { ...rest, state: 'dismissed', updatedAt: new Date(now()).toISOString() };
      });
      if (!changed) return;
      // only a tap that carried the decision it saw, on mail that passed the sender check, says anything about the sender's domain (a spoofed sender teaches nothing)
      const teaches = decisionId !== undefined && latest.senderStatus === 'pass' && typeof ended?.fromDomain === 'string';
      await store.addReaction({
        kind: 'not_needed',
        rowId: id,
        matterKey: decision.matterKey,
        decidedBy: decision.decidedBy,
        outcome: decision.outcome,
        fromDomain: teaches ? ended.fromDomain : null,
        at: now(),
      });
    },
    /** The owner chose to make a signal MoMo suggested into a rule, or to ignore it. */
    'signal.make': async (/** @type {{ id: string }} */ { id }) => react('signal_make', id),
    'signal.ignore': async (/** @type {{ id: string }} */ { id }) => react('signal_ignore', id),
    /** The owner hid an offer on the brief: it is not offered again. */
    'brief.hide': async (/** @type {{ offerId: string }} */ { offerId }) => {
      const id = needId(offerId);
      if (!offerShown(id)) throw new IntentError(GONE);
      await store.hideOffer(id);
    },
    /** "Draft a reply" from the notification: a draft row for the owner to read; nothing is sent. */
    'notice.draft': async (/** @type {{ key: string }} */ { key }) => void (await draft(needId(key))),
    /** "Remind me later" from the notification: one reminder, a few hours on, at most three times for a notice. */
    'notice.remind': async (/** @type {{ key: string }} */ { key }) => remind(needId(key)),
    /** The notice settings: only the keys a screen has, each checked, mapped onto MoMo's prefs. */
    'settings.set': async (/** @type {{ patch: Record<string, unknown> }} */ { patch }) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new IntentError('That is not something MoMo can do.');
      const keys = Object.keys(patch);
      for (const key of keys) {
        const ok = Object.hasOwn(SETTINGS, key) ? SETTINGS[/** @type {keyof typeof SETTINGS} */ (key)](patch[key]) : false;
        if (!ok) throw new IntentError(`That setting (${key}) is not one MoMo can change.`);
      }
      /** @type {Record<string, unknown>} */
      const change = {};
      if ('briefOn' in patch || 'briefTime' in patch)
        change.brief = { ...('briefOn' in patch ? { on: patch.briefOn } : {}), ...('briefTime' in patch ? { time: patch.briefTime } : {}) };
      if ('quietFrom' in patch || 'quietTo' in patch) {
        // quiet hours are one window: a half is not enough to change it
        if (!('quietFrom' in patch && 'quietTo' in patch)) throw new IntentError('Quiet hours need both a start and an end.');
        change.quietHours = { start: patch.quietFrom, end: patch.quietTo };
      }
      if ('dailyCap' in patch || 'previews' in patch)
        change.notify = {
          ...('dailyCap' in patch ? { tellNowMax: patch.dailyCap } : {}),
          ...('previews' in patch ? { previews: patch.previews } : {}),
        };
      await home.prefs.change(change);
    },
  };
}
