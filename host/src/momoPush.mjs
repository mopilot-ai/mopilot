// MoMo's push on a Host (S7, design Function 3): every push MoMo sends goes through one pipeline: the fixed "MoMo needs you" with opaque handles (never a title, tool or chat text; text only sealed, only on opt-in), held to the end of quiet hours, capped and deduped across restarts, fenced to the running home at every step (a push held through the night is re-checked when it is released), and cleared on every phone when the card is answered anywhere. The approval engine's cards (`notify`) and the notice lane's items (`tell`) share it, with one source of quiet hours and one time zone: the home's.
import { chatRef } from '../../shared/remote/ref.mjs';
import { hostZone, quietEndsAt, zonedParts } from './momoClock.mjs';
import { DEFAULT_TELL_NOW_MAX } from './momoPrefs.mjs';
import { DEFAULTS } from './momoDaily.mjs';

/** What MoMo may push for. The relay is told one kind, `momoNeedsYou`, for all of them (it titles it "MoMo needs you"); the kind decides only the cap, quiet hours and what a preview says. */
export const TELL_KINDS = /** @type {const} */ (['reply', 'question', 'approval', 'brief', 'catchUp', 'remind']);
/** The kinds the daily cap counts: the notice lane's tell-now items. An approval a run is blocked on always reaches the phone, and a brief and a catch-up are the day's own cards. */
const COUNTED = new Set(['reply', 'question']);
/** Whether a push is one the daily cap counts: a tell-now item, never a card a run is waiting on (an approval, or a question that carries its card): that one is held back by quiet hours only and is never dropped for the cap. @param {{ kind: string, cardId?: string }} item */
const counted = (item) => COUNTED.has(item.kind) && !item.cardId;
/** The day's own cards: a brief or catch-up held through quiet hours is dropped at their end, because the new day's brief carries what they said. */
const DAILY = new Set(['brief', 'catchUp']);
/** A card is answered only by its own answer, never by a notification button on something else. */
const CARDS = new Set(['approval']);
/** How long a sent push is remembered, so an answer can clear it and a repeat is not sent again. */
const KEEP_MS = 2 * 24 * 60 * 60_000;
/** Clears that failed are tried again at each release, this many times. */
const MAX_CLEAR_TRIES = 8;
/** A reservation with no phone reached is a crash between the reservation and the send once it is this old: the next try takes it over instead of calling itself a duplicate for ever. */
const RESERVE_TTL_MS = 2 * 60_000;
/** What a push that could not be sent (the relay down, no phone yet) waits before it is tried again: doubling, never more than this. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** Relay answers that end a push for good. */
const SENT = 'sent';

/** @param {any} v */
export const pushShape = (v) => ({
  day: typeof v?.day === 'string' ? v.day : '',
  count: Number.isInteger(v?.count) && v.count > 0 ? v.count : 0,
  sent: v?.sent && typeof v.sent === 'object' && !Array.isArray(v.sent) ? v.sent : {},
  held: v?.held && typeof v.held === 'object' && !Array.isArray(v.held) ? v.held : {},
});

/** A store that keeps the day's count in memory, for a Host whose data dir is not given. */
function memoryStore() {
  const v = pushShape(null);
  return { read: () => v, change: async (/** @type {(v: any) => any} */ fn) => fn(v) };
}

/**
 * @param {object} o
 * @param {() => { hostId: string, pairId: string }[]} o.targets the phone enrollments now (a Mac's is never among them)
 * @param {(hostId: string, req: { pair: string, kind: string, ref: string, card?: string, sealedBody?: string, sealedStamp?: string }) => Promise<string>} o.send one push request on that enrollment's link; resolves with the relay's status (`sealedStamp`: the lease, sealed for the phone)
 * @param {() => boolean} o.allowed whether MoMo is on for this Host's account now: nothing is pushed for a grant that has ended
 * @param {(message: string) => void} [o.report]
 * @param {() => number} [o.now]
 * @param {{ read: () => ReturnType<typeof pushShape>, change: <R>(fn: (v: ReturnType<typeof pushShape>) => R) => Promise<R> }} [o.store] the day's count, the pushes sent and the ones held, kept across a restart
 * @param {() => { previews: boolean, tellNowMax: number, zone: string, quiet: { start: number, end: number } | null }} [o.settings] the owner's choices: lock-screen text (off), the daily cap, and the home's zone and quiet hours (the one source of both)
 * @param {(target: { hostId: string, pairId: string, root?: Uint8Array }, ref: string, text: string) => string | null} [o.sealBody] the text sealed end to end for that phone; null when this Host cannot (the push then says only "MoMo needs you")
 * @param {(target: { hostId: string, pairId: string, root?: Uint8Array }, ref: string, stamp: { homeId: string, leaseEpoch: number }) => string | null} [o.sealStamp] the lease sealed for that phone (shared/remote/stampSeal.mjs); null when this Host cannot: the push then carries no stamp
 * @param {(a: { day: string, max: number, key: string }) => Promise<boolean> | boolean} [o.claimTold] the notice store's atomic daily count (`tryCountTold`), when it has one: then it is the only counter and the Host counts none
 * @param {(a: { day: string, key: string }) => Promise<unknown> | unknown} [o.releaseTold] gives that count back when the push reached no phone
 * @param {() => { homeId: string, leaseEpoch: number } | null} [o.stamp] the home's lease an action begins under; none (the default) pushes nothing
 * @param {(stamp: unknown) => boolean} [o.current] whether that lease is still the home's; the default says no
 * @param {(stamp: unknown) => { ok: boolean } | Promise<{ ok: boolean }>} [o.receive] the home's stamp sink (`home.receiveStamp`): a stamp older than the newest lease seen, or at the same lease from another machine, is not sent under
 */
export function createMomoPush({
  targets,
  send,
  allowed,
  report = () => undefined,
  now = Date.now,
  store = memoryStore(),
  settings = () => ({ previews: false, tellNowMax: DEFAULT_TELL_NOW_MAX, zone: hostZone(), quiet: { ...DEFAULTS.quiet } }),
  sealBody = () => null,
  sealStamp = () => null,
  claimTold = undefined,
  releaseTold = undefined,
  stamp = () => null,
  current = () => false,
  receive = () => ({ ok: true }),
}) {
  /** What last went wrong per phone, until a push to it is sent again: the cause and the one-tap fix. @type {Map<string, { code: string, since: number }>} */
  const trouble = new Map();
  /** Phones a push was ever sent to: a phone with no token that had one lost it (the token went bad); one that never had one never allowed notifications. @type {Set<string>} */
  const reached = new Set();
  let previewsReported = false;
  let releasing = false;

  /** The lease an action may go on under: MoMo is on here and this Host is the running home; else null. */
  const lease = () => (allowed() ? stamp() : null);
  /** @param {unknown} mine */
  const live = async (mine) => !!mine && !!lease() && current(mine) && (await receive(mine)).ok;

  /** One push of `item` to every phone, sealed text only when previews are on and this Host can seal it, with the lease it was sent under; resolves the phones that were sent it. @param {any} item @param {{ hostId: string, pairId: string }[]} phones @param {{ homeId: string, leaseEpoch: number }} mine */
  async function deliver(item, phones, mine) {
    const wantText = settings().previews && typeof item.text === 'string' && item.text !== '';
    /** @type {{ hostId: string, pairId: string }[]} */
    const reachedNow = [];
    await Promise.all(
      phones.map(async (t) => {
        const ref = chatRef(t.pairId, item.chatId ?? 'momo');
        const sealed = wantText ? sealBody(t, ref, item.text) : null;
        const stampSealed = sealStamp(t, ref, mine);
        if (wantText && !sealed && !previewsReported) {
          previewsReported = true;
          report('MoMo push: lock-screen text is on but this Host cannot seal it for the phone, so the push says only "MoMo needs you"');
        }
        const req = {
          pair: t.pairId,
          kind: 'momoNeedsYou',
          ref,
          ...(item.cardId ? { card: chatRef(t.pairId, item.cardId) } : {}),
          ...(sealed ? { sealedBody: sealed } : {}),
          // the lease it was sent under, sealed for this phone alone, so that a phone can drop a push older than the newest it has seen for this home; nothing between can read or move that line. NOT YET TRUE end to end: the phone's side (momo-phone-ui #5485) and the relay's forwarding (#5519, not deployed) are not in place, so today no receiver refuses a stale push
          ...(stampSealed ? { sealedStamp: stampSealed } : {}),
        };
        try {
          const status = await send(t.hostId, req);
          if (status === SENT) {
            reachedNow.push(t);
            reached.add(t.pairId);
            trouble.delete(t.pairId);
          } else if (status === 'no_token')
            // a phone that was reached before and has no token now lost it; one never reached never allowed notifications
            trouble.set(t.pairId, { code: reached.has(t.pairId) ? 'token_invalid' : 'notifications_off', since: now() });
          else if (status === 'disabled') trouble.set(t.pairId, { code: 'push_disabled', since: now() });
        } catch (/** @type {any} */ error) {
          report(`MoMo push: ${error.message}`);
          if (error?.code !== 'bad_message') trouble.set(t.pairId, { code: 'relay_unreachable', since: now() });
        }
      }),
    );
    return reachedNow;
  }

  /** A push that reached no phone gives back its place in the day and its key, so a later try can go out. @param {any} item @param {string} day */
  const release = async (item, day) => {
    await store.change((v) => {
      delete v.sent[item.key];
      // the day may have turned since it was reserved: the store's shape reads a count under zero as none
      if (counted(item) && !claimTold) v.count -= 1;
    });
    if (claimTold && counted(item)) await releaseTold?.({ day, key: item.key });
  };

  /** The push itself, once quiet hours are past, under the lease the caller found. @param {any} item @param {{ homeId: string, leaseEpoch: number }} mine @returns {Promise<{ status: string, sent?: number }>} */
  async function proceed(item, mine) {
    const phones = targets();
    if (phones.length === 0) {
      report('MoMo push: no phone is linked to this Host, so nothing is pushed');
      return { status: 'no_phone' };
    }
    const set = settings();
    const at = now();
    const day = zonedParts(at, set.zone).day;
    // reserved before sending and kept across a restart: a repeat of the same key, or one more than the day's cap, never goes out
    const reserved = await store.change((v) => {
      if (v.day !== day) {
        v.day = day;
        v.count = 0;
      }
      for (const [k, e] of Object.entries(v.sent)) if (at - e.at > KEEP_MS) delete v.sent[k];
      const was = v.sent[item.key];
      // a push that was sent, or one being sent right now, is a duplicate; a reservation that reached nobody and is old is a crash, and this try takes it over
      if (was && (was.wasSent || at - was.at < RESERVE_TTL_MS)) return 'duplicate';
      if (counted(item) && !claimTold && !was && v.count >= set.tellNowMax) return 'capped';
      // a taken-over reservation was counted when it was made
      if (counted(item) && !claimTold && !was) v.count += 1;
      v.sent[item.key] = { at, kind: item.kind, ...(item.chatId ? { chatId: item.chatId } : {}), phones: [] };
      return 'ok';
    });
    if (reserved !== 'ok') return { status: reserved };
    // the notice store counts the day when it has the counter; a refusal there gives the key back
    if (claimTold && counted(item) && !(await claimTold({ day, max: set.tellNowMax, key: item.key }))) {
      await release(item, day);
      return { status: 'capped' };
    }
    if (!(await live(mine))) {
      await release(item, day);
      report('MoMo push: refused, this home has moved on');
      return { status: 'not-home' };
    }
    const reachedNow = await deliver(item, phones, mine);
    if (reachedNow.length === 0) {
      await release(item, day);
      return { status: 'failed' };
    }
    const asked = await store.change((v) => {
      const e = v.sent[item.key];
      e.phones = reachedNow.map((t) => ({ hostId: t.hostId, pairId: t.pairId }));
      e.wasSent = true;
      return e.wantClear === true;
    });
    // answered while this push was still going out: it is cleared at once
    if (asked) await clearOne(item.key);
    return { status: 'sent', sent: reachedNow.length };
  }

  /** Tell every phone that was sent `key` that it is no longer needed; a phone whose clear failed is kept for the next release. @param {string} key */
  async function clearOne(key) {
    const entry = store.read().sent[key];
    let told = 0;
    /** @type {{ hostId: string, pairId: string }[]} */
    const left = [];
    for (const t of entry.phones) {
      try {
        await send(t.hostId, { pair: t.pairId, kind: 'cleared', ref: chatRef(t.pairId, entry.chatId ?? 'momo') });
        told += 1;
      } catch (/** @type {any} */ error) {
        report(`MoMo push: ${error.message}`);
        left.push(t);
      }
    }
    await store.change((v) => {
      const e = v.sent[key];
      e.phones = left;
      e.clearTries = left.length ? (e.clearTries ?? 0) + 1 : 0;
      if (!left.length || e.clearTries >= MAX_CLEAR_TRIES) e.cleared = true;
    });
    return told;
  }

  /** @param {any} item @returns {Promise<{ status: string, until?: number, sent?: number }>} */
  async function tell(item) {
    if (!allowed()) return { status: 'off' };
    const mine = lease();
    if (!mine) return { status: 'not-home' };
    if (!TELL_KINDS.includes(item?.kind) || typeof item.key !== 'string' || !item.key) return { status: 'invalid' };
    const set = settings();
    const at = now();
    const until = quietEndsAt(set.quiet, at, set.zone);
    if (until !== null) {
      // nothing breaks through quiet hours: it waits, kept across a restart, and the newest of a key replaces an older one
      await store.change((v) => void (v.held[item.key] = item));
      return { status: 'held', until };
    }
    const out = await proceed(item, mine);
    // a push that could not go out now (the relay is down, no phone is linked yet) is kept and tried again, so a run is never left waiting on a card the phone never heard of; a brief or catch-up is a nudge the chat already carries
    if ((out.status === 'failed' || out.status === 'no_phone') && !DAILY.has(item.kind)) await keep(item, at);
    return out;
  }

  /** Keep an item for the next release, with its first time and when to try again. @param {any} item @param {number} at */
  const keep = (item, at) =>
    store.change((v) => {
      const had = v.held[item.key];
      const tries = (had?.tries ?? -1) + 1;
      v.held[item.key] = { ...item, heldAt: had?.heldAt ?? at, tries, notBefore: at + Math.min(RETRY_BASE_MS * 2 ** tries, RETRY_MAX_MS) };
    });

  /**
   * The person answered `key` on one device: a push held for quiet hours is dropped, and the phones that were sent it are told it is no longer needed (the relay replaces it with a quiet notice on each). A card is cleared only by its own answer (`by: 'card'`), never by a notification button.
   * @param {string} key @param {{ by?: 'card' | 'button' }} [how] @returns {Promise<number>} how many phones were told
   */
  async function answered(key, how = { by: 'card' }) {
    const entry = store.read().sent[key];
    if (entry && CARDS.has(entry.kind) && how.by !== 'card') return 0;
    await store.change((v) => {
      delete v.held[key];
      // an answer that comes while its push is going out is remembered, and cleared when it lands
      if (v.sent[key] && !v.sent[key].cleared) v.sent[key].wantClear = true;
    });
    if (!entry || entry.cleared) return 0;
    if (!(await live(lease()))) return 0;
    return clearOne(key);
  }

  return {
    tell,
    answered,
    /**
     * At each tick: pushes held through quiet hours go out once they are over, under the lease as it is now (a home that moved, or a grant that ended, sends nothing); a brief or catch-up held overnight is dropped, the new day's brief carries it; clears that failed are tried again.
     * @returns {Promise<{ sent: number, dropped: number, cleared: number }>}
     */
    async release() {
      const out = { sent: 0, dropped: 0, cleared: 0 };
      const mine = lease();
      if (releasing || !mine) return out;
      releasing = true;
      try {
        const set = settings();
        if (quietEndsAt(set.quiet, now(), set.zone) === null) {
          // nothing leaves `held` before it is dealt with: an item the relay would not take, or one the lease stopped, stays for the next release
          for (const item of Object.values(store.read().held)) {
            const gone = () => store.change((v) => void delete v.held[item.key]);
            if (DAILY.has(item.kind)) {
              await gone();
              out.dropped += 1;
              continue;
            }
            if (item.notBefore > now()) continue;
            if (!(await live(mine))) break;
            const at = now();
            const result = await proceed(item, mine);
            if (result.status === 'sent') out.sent += 1;
            if (result.status === 'failed' || result.status === 'no_phone') {
              // tried again later, for as long as a push is worth anything
              if (at - (item.heldAt ?? at) > KEEP_MS) await gone();
              else await keep(item, at);
            } else if (result.status !== 'not-home') await gone();
          }
        }
        for (const [key, e] of Object.entries(store.read().sent))
          if (e.wantClear && !e.cleared && e.phones.length && (await live(mine))) out.cleared += await clearOne(key);
      } finally {
        releasing = false;
      }
      return out;
    },
    /**
     * The approval gate's one hook (`gate.subscribe`, shared/momoCore/approvalGate.ts): a card that opens is pushed as an approval, one answered or expired anywhere is cleared on every phone, and `used` says nothing the person needs.
     * @param {{ cardId: string, status: string, chatId?: string }} change
     */
    async cardChanged(change) {
      if (change.status === 'open')
        return tell({ kind: 'approval', key: change.cardId, cardId: change.cardId, ...(change.chatId ? { chatId: change.chatId } : {}) });
      if (['allowed', 'denied', 'expired'].includes(change.status))
        return { status: 'cleared', told: await answered(change.cardId, { by: 'card' }) };
      return { status: 'ignored' };
    },
    /**
     * The approval engine's push port for a MoMo chat's card: a waiting card is pushed once (a reminder is not pushed again: the notification is already on the phone), a card that ran out its time pauses the run and its held push is dropped, a card that is no longer waiting is cleared.
     * @param {{ kind: string, chatId: string, card?: { requestId?: string, cardKind?: string } }} event
     */
    async notify(event) {
      if (!allowed()) return undefined;
      const key = event.card?.requestId ?? `chat:${event.chatId}`;
      if (event.kind === 'needsYou')
        return tell({
          kind: event.card?.cardKind === 'question' ? 'question' : 'approval',
          key,
          chatId: event.chatId,
          ...(event.card?.requestId ? { cardId: event.card.requestId } : {}),
        });
      if (event.kind === 'paused') return void (await store.change((v) => void delete v.held[key]));
      if (event.kind === 'cleared') {
        // the event names the chat: every card of it that was pushed is cleared
        for (const [k, e] of Object.entries(store.read().sent))
          if (e.chatId === event.chatId && !e.cleared) await answered(k, { by: 'card' });
        await store.change((v) => {
          for (const [k, item] of Object.entries(v.held)) if (/** @type {any} */ (item).chatId === event.chatId) delete v.held[k];
        });
      }
      return undefined;
    },
    /** Whether a push for this key was issued by this home (a notification button names only keys that were). @param {string} key */
    knows: (key) => !!store.read().sent[key],
    /** Whether a button on this notification already did its work (kept across a restart). @param {string} key */
    intentDone: (key) => store.read().sent[key]?.intent === true,
    /** Reserve (`true`) or give back (`false`) the one answer a notification's buttons may give. @param {string} key @param {boolean} on */
    async markIntent(key, on) {
      await store.change((v) => void (v.sent[key] && (v.sent[key].intent = on)));
    },
    /** Whether a push was ever sent to a phone (notification permission is then known to be on). */
    reachedAny: () => reached.size > 0 || Object.values(store.read().sent).some((e) => e.phones?.length > 0 || e.wasSent),
    /** What is wrong with a phone's pushes now, each with the real cause and the one-tap fix, for the Host's status: nothing when all is well. */
    failures() {
      const fixes = /** @type {Record<string, { id: string, label: string, cause: string }>} */ ({
        notifications_off: { id: 'open_settings', label: 'Open Settings', cause: 'Notifications are off. MoMo keeps things in Chat.' },
        token_invalid: {
          id: 'pair_again',
          label: 'Pair again',
          cause: "This iPhone can't receive notifications from this Mac. Its notification address is gone.",
        },
        relay_unreachable: { id: 'retry', label: 'Try again', cause: "MoMo couldn't reach the relay to notify this iPhone." },
        push_disabled: { id: 'retry', label: 'Try again', cause: 'Notifications are turned off for this account on the relay.' },
      });
      return [...trouble].map(([pairId, t]) => ({ pairId, code: t.code, since: t.since, ...fixes[t.code] }));
    },
  };
}
