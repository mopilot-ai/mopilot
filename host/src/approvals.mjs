// The approval engine (U1): for every chat on this Host, which cards wait and since when, the clock that reminds and then pauses the run, who answered first, and the `attention` a client reads from the chat's state lane. Memory only: a restart ends every pending request (./recovery.mjs closes their cards).
import {
  CARD_ANSWERED,
  DEFAULT_PAUSE_MINUTES,
  DEFAULT_REMIND_MINUTES,
  optionKindOf,
  principalOf,
  summaryOf,
} from '../../shared/host/approvals.mjs';
import { HostRefusal } from './hostFs.mjs';

const MINUTE = 60_000;
/** How many answered or closed cards are remembered, so a late answer or a late runtime event is told from a new card. */
const REMEMBERED = 1000;
/** How many of them `host.pending` reports: enough for every card a client still shows. */
const RECENT_CLOSED = 50;
/** The line a chat's next turn starts with after a pause: the agent is told, not left to guess. */
export const NOT_RUN_NOTICE = 'The action you were waiting to run was not run, because nobody answered in time.';

/** The turn a closed card belongs to, as the close item carries it (nothing for a card with none), so every client can place the card's outcome in its turn. @param {unknown} turnId */
const turnOf = (turnId) => (typeof turnId === 'string' && turnId ? { turnId } : {});

/** The clock for a chat: remind and pause, in ms. The policy lane (U2) replaces this one function with the owner's `approvals.remindMinutes` and `pauseMinutes`. @returns {{ remindMs: number, pauseMs: number }} */
export const approvalTimes = () => ({ remindMs: DEFAULT_REMIND_MINUTES * MINUTE, pauseMs: DEFAULT_PAUSE_MINUTES * MINUTE });

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The id of the card a runtime `permission` or `question` event opens. @param {any} e */
const requestIdOf = (e) => (e.kind === 'question' ? e.question?.id : e.requestId);

/** Whether a card shows a link to open rather than a tool call to allow: the options are the ones both harnesses give a link (`done`, `cancel`). @param {any} e */
const isLink = (e) =>
  ['done', 'cancel'].every((id) => Array.isArray(e.options) && e.options.some((/** @type {any} */ o) => o?.optionId === id));

/** A second answer to a card: refused with who answered first and when. A normal outcome, not an error to retry. */
class CardAnsweredError extends HostRefusal {
  /** @param {{ by: unknown, at: number }} first */
  constructor(first) {
    super(CARD_ANSWERED, 'Someone already answered this.');
    this.details = { by: first.by, at: first.at };
  }
}

/**
 * @param {object} o
 * @param {(chatId: string, event: object) => void} o.record writes a durable event of the chat (the protocol's own record)
 * @param {(chatId: string, patch: Record<string, unknown>) => unknown} o.state the chat's state lane
 * @param {(chatId: string) => unknown} o.stop stops the chat's turn and with it every request it waits on
 * @param {(chatId: string) => number} o.epochOf
 * @param {(chatId: string) => string} o.familyOf
 * @param {(event: { kind: 'needsYou' | 'reminder' | 'paused' | 'blocked' | 'cleared', chatId: string, card?: object }) => unknown} [o.notify] the push port ('cleared': the last card of a chat was answered or withdrawn, so a push for it should go); the default does nothing (P4 supplies the real one)
 * @param {() => { remindMs: number, pauseMs: number }} [o.times]
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => () => void} [o.after] runs `fn` once after `ms`; returns the cancel
 * @param {(chatId: string) => unknown} [o.skipped] told once when a `skip` run stopped at a card (U3)
 * @param {(chatId: string) => Record<string, any> | undefined} [o.saved] the chat's state lane as it was kept, for a Host that restarted with a chat paused
 * @param {(message: string) => void} [o.report]
 * @param {{ governed: (e: any) => boolean, note: (e: any) => void }} [o.audit] the audit record: a card asked and expired is noted, an answer is written before it is taken (`audit.required` refuses it otherwise)
 */
export function createApprovals({
  record,
  state,
  stop,
  epochOf,
  familyOf,
  notify = () => undefined,
  times = approvalTimes,
  now = Date.now,
  after,
  skipped = () => undefined,
  saved = () => undefined,
  report = () => undefined,
  audit = { governed: () => true, note: () => undefined },
}) {
  const later =
    after ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  /** The cards that wait, per chat, with the clock they share. @type {Map<string, { since: number, cards: Map<string, any>, cancel: (() => void)[], pauseMs: number }>} */
  const waiting = new Map();
  /** The chats of scheduled runs that skip an approval rather than wait for it, until the run's turn ends. @type {Set<string>} */
  const skipping = new Set();
  /** What a chat needs from a person besides a card: paused for no answer, or a credential. @type {Map<string, { kind: string, since: number, reason?: string, pauseMinutes?: number }>} */
  const others = new Map();
  /** Answers that were taken and cards that were closed, as `chatId\nrequestId`. @type {Map<string, { by: any, at: number } | null>} */
  const settled = new Map();
  /** An answer taken (first wins) and not yet applied. @type {Map<string, { by: any, at: number, optionKind: string, turnId?: string }>} */
  const claims = new Map();

  const keyOf = (/** @type {string} */ chatId, /** @type {string} */ requestId) => `${chatId}\n${requestId}`;
  /** @param {string} key @param {{ by: any, at: number } | null} how */
  const remember = (key, how) => {
    settled.delete(key);
    settled.set(key, how);
    if (settled.size > REMEMBERED) settled.delete(/** @type {string} */ (settled.keys().next().value));
  };

  /** The chat's `attention` now, or null. @param {string} chatId */
  const attentionOf = (chatId) => {
    const w = waiting.get(chatId);
    if (w && w.cards.size > 0) return { kind: 'approval', since: w.since, cards: [...w.cards.keys()] };
    const o = others.get(chatId);
    return o ? { ...o } : null;
  };
  /** Tell the state lane; a failing lane never changes what the engine decided. @param {string} chatId */
  const publish = (chatId) => {
    try {
      state(chatId, { attention: attentionOf(chatId) });
    } catch {
      report('A chat’s attention could not be published.');
    }
  };
  /** A port that fails never resets the clock or the answer. @param {Parameters<NonNullable<typeof notify>>[0]} message */
  const tell = (message) => {
    try {
      Promise.resolve(notify(message)).catch(() => report('A notification could not be sent.'));
    } catch {
      report('A notification could not be sent.');
    }
  };
  const stopClock = (/** @type {string} */ chatId) => {
    const w = waiting.get(chatId);
    if (!w) return;
    for (const c of w.cancel.splice(0)) c();
  };
  /** @param {string} chatId @param {string} requestId */
  const close = (chatId, requestId) => {
    const w = waiting.get(chatId);
    if (!w?.cards.delete(requestId)) return false;
    remember(keyOf(chatId, requestId), null);
    if (w.cards.size === 0) {
      stopClock(chatId);
      waiting.delete(chatId);
    }
    return true;
  };
  /** Closes the chat's waiting cards in the record, each once, with the reason. @param {string} chatId @param {string} reason @param {(card: any) => boolean} [only] */
  const closeAll = (chatId, reason, only = () => true) => {
    const w = waiting.get(chatId);
    if (!w) return;
    for (const [requestId, card] of [...w.cards]) {
      if (!only(card) || claims.has(keyOf(chatId, requestId))) continue;
      close(chatId, requestId);
      if (reason === 'expired')
        audit.note({ kind: 'approval.expired', chat: chatId, turn: card.turnId, what: { tool: card.tool, waitedMs: now() - card.at } });
      try {
        record(chatId, { kind: 'permissionCancelled', requestId, ...turnOf(card.turnId), at: now(), reason });
      } catch {
        report('A closed card could not be recorded.');
      }
    }
    // an expiry is followed by the pause, which replaces the push itself; any other close leaves nothing waiting
    if (reason !== 'expired' && !waiting.has(chatId)) tell({ kind: 'cleared', chatId });
    publish(chatId);
  };

  /** A chat this process has not heard of: what its state lane kept is its attention if the chat was paused or blocked, and stale if it was a card (a restart ended the request). @param {string} chatId */
  function restore(chatId) {
    if (waiting.has(chatId) || others.has(chatId)) return;
    const was = saved(chatId)?.attention;
    if (!isObject(was)) return;
    if (was.kind === 'paused' || was.kind === 'credential')
      others.set(chatId, {
        kind: was.kind,
        since: Number(was.since) || now(),
        ...(was.reason ? { reason: String(was.reason) } : {}),
        ...(Number.isSafeInteger(was.pauseMinutes) ? { pauseMinutes: was.pauseMinutes } : {}),
      });
    else publish(chatId);
  }

  /** A turn's end and the chat's credential: one that failed for lack of a model credential (the harness's typed `auth` code, never its words) needs this Mac to sign in again; a turn that ran to its end clears it. @param {string} chatId @param {any} e a `turnEnd` */
  function credential(chatId, e) {
    if (e.error?.code === 'auth') needs(chatId, { kind: 'credential' });
    else if (e.stopReason === 'end_turn' && !e.error) {
      // a stop a Host kept across a restart is cleared too
      restore(chatId);
      clearNeeds(chatId);
    }
  }

  /** A chat needs this Host's person for something besides a card. @param {string} chatId @param {{ kind: 'credential' }} what */
  function needs(chatId, what) {
    if (waiting.has(chatId) || others.get(chatId)?.kind === what.kind) return;
    others.set(chatId, { kind: what.kind, since: now() });
    publish(chatId);
    tell({ kind: 'blocked', chatId });
  }

  /** A turn that ran clears a credential stop; a pause or a card is not its to clear. @param {string} chatId */
  function clearNeeds(chatId) {
    if (others.get(chatId)?.kind !== 'credential') return;
    others.delete(chatId);
    publish(chatId);
  }

  /** A `skip` run reached a card: it is closed at once as expired, the turn stops, and the schedule is told once. @param {string} chatId @param {string} requestId @param {string} [turnId] */
  function skip(chatId, requestId, turnId) {
    remember(keyOf(chatId, requestId), null);
    audit.note({ kind: 'approval.expired', chat: chatId, what: { status: 'skipped' } });
    try {
      record(chatId, { kind: 'permissionCancelled', requestId, ...turnOf(turnId), at: now(), reason: 'expired' });
    } catch {
      report('A closed card could not be recorded.');
    }
    const first = others.get(chatId)?.kind !== 'paused';
    others.set(chatId, { kind: 'paused', since: now(), reason: 'approval_timeout' });
    publish(chatId);
    try {
      Promise.resolve(stop(chatId)).catch(() => report('A paused chat could not be stopped.'));
    } catch {
      report('A paused chat could not be stopped.');
    }
    if (first) skipped(chatId);
  }

  /** The clock ran out: each card closes as expired, the turn stops, the chat is paused. @param {string} chatId */
  function pause(chatId) {
    // the pause the owner's clock gave this card says how long nobody answered, to every client that words it
    const pauseMinutes = Math.round(/** @type {NonNullable<ReturnType<typeof waiting.get>>} */ (waiting.get(chatId)).pauseMs / MINUTE);
    stopClock(chatId);
    others.set(chatId, { kind: 'paused', since: now(), reason: 'approval_timeout', pauseMinutes });
    closeAll(chatId, 'expired');
    // an answer taken a moment ago is applied; its card closes when it does
    try {
      Promise.resolve(stop(chatId)).catch(() => report('A paused chat could not be stopped.'));
    } catch {
      report('A paused chat could not be stopped.');
    }
    publish(chatId);
    tell({ kind: 'paused', chatId });
  }

  /** @param {string} chatId @param {any} e a runtime `permission` or `question` */
  function open(chatId, e) {
    const requestId = requestIdOf(e);
    if (typeof requestId !== 'string' || !requestId) return;
    const kind = e.kind === 'question' ? 'question' : isLink(e) ? 'link' : 'permission';
    const at = now();
    const call = e.kind === 'question' ? { title: String(e.question?.message ?? '') } : e.toolCall;
    const card = {
      chatId,
      epoch: epochOf(chatId),
      requestId,
      ...(typeof e.turnId === 'string' ? { turnId: e.turnId } : {}),
      family: familyOf(chatId),
      cardKind: kind,
      summary: summaryOf(call, kind === 'link' ? 'permission' : kind),
      tool: typeof call?.kind === 'string' ? call.kind : undefined,
      options: (Array.isArray(e.options) ? e.options : [])
        .filter(isObject)
        .map((o) => ({ optionId: String(o.optionId), name: String(o.name ?? ''), kind: optionKindOf(o.kind) })),
      ...(isObject(e.question?.form) ? { form: e.question.form } : {}),
      at,
    };
    let w = waiting.get(chatId);
    others.delete(chatId);
    const first = !w;
    if (!w) {
      w = { since: at, cards: new Map(), cancel: [], pauseMs: times().pauseMs };
      waiting.set(chatId, w);
    }
    w.cards.set(requestId, card);
    if (first) {
      const { remindMs } = times();
      const { pauseMs } = w;
      w.cancel.push(
        later(() => tell({ kind: 'reminder', chatId }), remindMs),
        later(() => pause(chatId), pauseMs),
      );
    }
    audit.note({ kind: 'approval.asked', chat: chatId, turn: card.turnId, what: { tool: card.tool, cardKind: kind } });
    publish(chatId);
    tell({ kind: 'needsYou', chatId, card });
  }

  return {
    /**
     * A runtime event on its way to the chat's record: a card opens or closes here, and the record gets it with its time and reason, or nothing when the engine already recorded the close.
     * @param {string} chatId @param {any} e @returns {any | null} the event to record, or null to leave it out
     */
    seen(chatId, e) {
      if (e.kind === 'permission' || e.kind === 'question') {
        const requestId = requestIdOf(e);
        const out = { ...e, at: now() };
        if (skipping.has(chatId) && typeof requestId === 'string' && requestId) {
          // the card is on the record first, then closed
          record(chatId, out);
          skip(chatId, requestId, e.turnId);
          return null;
        }
        open(chatId, e);
        return out;
      }
      if (e.kind === 'permissionCancelled') {
        const key = keyOf(chatId, e.requestId);
        // closed by an answer, the clock or a Stop already: that record is the one clients read
        if (claims.has(key) || settled.has(key)) return null;
        const turnId = waiting.get(chatId)?.cards.get(e.requestId)?.turnId;
        const had = close(chatId, e.requestId);
        if (had) publish(chatId);
        return { ...e, ...turnOf(turnId), at: now(), reason: 'turn_ended' };
      }
      if (e.kind === 'turnEnd') skipping.delete(chatId);
      if (e.kind === 'turnEnd') {
        closeAll(chatId, 'turn_ended', (card) => card.turnId === e.turnId);
        credential(chatId, e);
      }
      return e;
    },
    /**
     * Takes the first answer to a card. A card that no longer waits and was answered before refuses with `card_answered`; one that was never here returns null (the runtime says it has no such card, as it always did).
     * @param {{ chatId: string, requestId: string, optionId?: string, form?: unknown, by?: unknown }} p
     */
    claim(p) {
      const key = keyOf(p.chatId, p.requestId);
      const earlier = settled.get(key);
      if (claims.has(key) || earlier) {
        const first = claims.get(key) ?? earlier;
        throw new CardAnsweredError(/** @type {{ by: unknown, at: number }} */ (first));
      }
      const card = waiting.get(p.chatId)?.cards.get(p.requestId);
      if (!card) return null;
      const option = card.options.find((/** @type {any} */ o) => o.optionId === p.optionId);
      const claim = { by: principalOf(p.by), at: now(), optionKind: option ? option.kind : 'other', key, turnId: card.turnId };
      // with audit.required the answer is taken only once its line is written; a failure refuses it and leaves the card waiting
      audit.governed({
        kind: 'approval.answered',
        chat: p.chatId,
        turn: card.turnId,
        by: claim.by,
        what: { tool: card.tool, decision: claim.optionKind, waitedMs: claim.at - card.at, cardKind: card.cardKind },
      });
      claims.set(key, claim);
      return claim;
    },
    /** The answer did not reach a card (the runtime had none, or refused): the claim is let go. @param {{ key: string } | null} claim */
    unclaim(claim) {
      if (claim) claims.delete(claim.key);
    },
    /** The answer reached the card: it closes, and the chat's clock stops when no card is left. @param {string} chatId @param {string} requestId @param {{ key: string, by: any, at: number } | null} claim */
    answered(chatId, requestId, claim) {
      if (!claim) return;
      claims.delete(claim.key);
      close(chatId, requestId);
      remember(claim.key, { by: claim.by, at: claim.at });
      if (!waiting.has(chatId)) tell({ kind: 'cleared', chatId });
      publish(chatId);
    },
    /** The record of an answered card. @param {{ by: any, at: number, optionKind: string, turnId?: string } | null} claim @param {Record<string, unknown>} e */
    answeredEvent(claim, e) {
      const { by: _by, ...rest } = e;
      return {
        ...rest,
        ...turnOf(claim?.turnId),
        at: claim?.at ?? now(),
        reason: 'answered',
        ...(claim?.by ? { answeredBy: claim.by } : {}),
        optionKind: claim?.optionKind ?? 'other',
      };
    },
    /** A Stop: every card of the chat closes as stopped. @param {string} chatId */
    stopped(chatId) {
      closeAll(chatId, 'stopped');
    },
    /** The chat left this Host or moved to a new owner: nothing of it is kept. @param {string} chatId */
    forget(chatId) {
      stopClock(chatId);
      waiting.delete(chatId);
      others.delete(chatId);
    },
    /**
     * A message arrives for the chat: its attention clears, and a chat that was paused says so in the turn's first line.
     * @param {string} chatId @returns {string | null} the line to put in front of the message
     */
    resume(chatId) {
      restore(chatId);
      const was = others.get(chatId);
      // a pause ends with the person's message; a credential stop ends when a turn runs to its end (credential)
      if (was?.kind !== 'paused') return null;
      others.delete(chatId);
      if (!waiting.has(chatId)) publish(chatId);
      return NOT_RUN_NOTICE;
    },
    /** A Host that restarted: what its state lane kept of the chat is read, and a card it kept is cleared. @param {string} chatId */
    restore,
    /** A scheduled run's chat starts: with `skip` its cards close at once instead of waiting; anything else (an older app sends none) is `wait`. @param {string} chatId @param {string | undefined} onApproval */
    scheduled(chatId, onApproval) {
      if (onApproval === 'skip') skipping.add(chatId);
    },
    /** Whether a card of the chat waits for a person now (the previous run of a task is still working). @param {string} chatId */
    awaiting: (chatId) => (waiting.get(chatId)?.cards.size ?? 0) > 0,
    /**
     * What on this Host waits for a person: `host.pending`. `closed` is the latest cards that stopped waiting and who answered each (none when it was withdrawn),
     * so a client that still shows one can say how it ended without a tap on it.
     */
    pending() {
      const cards = [...waiting.values()].flatMap((w) => [...w.cards.values()]);
      const chats = new Set([...waiting.keys(), ...others.keys()]);
      const closed = [...settled].slice(-RECENT_CLOSED).map(([key, how]) => {
        const at = key.indexOf('\n');
        return { chatId: key.slice(0, at), requestId: key.slice(at + 1), ...(how?.by ? { by: how.by, at: how.at } : {}) };
      });
      return { cards, attention: [...chats].map((chatId) => ({ chatId, ...attentionOf(chatId) })), closed };
    },
    /** The attention of one chat, for the app's view. @param {string} chatId */
    attentionOf,
  };
}
