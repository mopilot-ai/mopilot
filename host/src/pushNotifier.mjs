// The Host's real `notify` (P4): one sealed push per phone enrollment on that enrollment's own relay link, with quiet-hours hold, a shared collapse id per chat, and bounded retry that never touches the approval clock.
import { createCardPush } from '../../shared/remote/cardPush.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { chatRef } from '../../shared/remote/ref.mjs';

/** Waits between tries of one push; its length is the bound, so a relay that stays down is tried this many times and then left (the card still waits). */
export const RETRY_MS = Object.freeze([2_000, 10_000, 60_000, 300_000]);
/** Statuses the relay gives that end a push for good; only `failed` (and a request that never answered) is tried again. */
const FINAL = new Set(['sent', 'suppressed', 'no_token', 'disabled']);

/** The notify kinds the engine raises (U1) and the state each carries to the phone. */
const STATE = { needsYou: 'waiting', reminder: 'reminder', paused: 'paused', cleared: 'cleared' };

/**
 * @typedef {{ hostId: string, pairId: string, root: Uint8Array }} PhoneTarget a phone enrollment: its relay link, pair and pair root
 * @typedef {{ kind: string, chatId: string, card?: { requestId: string, rev?: number, cardKind?: string, summary?: { tool?: string, line?: string, stat?: { files: number, added: number, removed: number } } } }} NotifyEvent
 */

/**
 * @param {object} o
 * @param {() => PhoneTarget[]} o.targets the phone enrollments now (a Mac's enrollment is never among them)
 * @param {(hostId: string, req: { pair: string, kind: string, ref: string, sealed?: string }) => Promise<string>} o.send one push request on that enrollment's link; resolves with the relay's status
 * @param {() => string} o.machineName
 * @param {() => 'minimal' | 'tool' | 'full'} [o.detail] `notify.detail` of the owner layer; `tool` until U2 provides it
 * @param {() => number | null} [o.quietUntil] when quiet hours end if they are on now, else null
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {(timer: any) => void} [o.clearTimer]
 * @param {(message: string) => void} [o.report]
 */
export function createPushNotifier({
  targets,
  send,
  machineName,
  detail = () => 'tool',
  quietUntil = () => null,
  now = Date.now,
  prim = createNodePrimitives(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimer = clearTimeout,
  report = () => undefined,
}) {
  const cards = createCardPush(prim);
  /** @type {Map<string, { event: NotifyEvent, ids: { requestId: string, rev: number } }>} chats with a card waiting: the card to repeat in a reminder, a pause or a clearing */
  const live = new Map();
  /** @type {Set<string>} chats a phone was actually sent a push for, so only those need a clearing */
  const told = new Set();
  /** @type {Map<string, NotifyEvent>} pushes held through quiet hours: the newest per chat */
  const held = new Map();
  /** @type {Set<string>} chats cleared during quiet hours, sent at its end */
  const clearLater = new Set();
  /** @type {Map<string, number>} per (enrollment, chat): the newest push's number, so an older push's retry stops when a newer one exists */
  const newest = new Map();
  /** @type {Map<any, () => void>} retry waits: a timer and what ends its wait early */
  const timers = new Map();
  let quietTimer = null;
  let seq = 0;
  let closed = false;
  /** Waiting cards raised while no phone was linked, and when the last was: nothing could be pushed for them (#4721). */
  let skipped = 0;
  /** @type {number | null} */
  let lastSkippedAt = null;

  /** Seal and send one chat's push to one phone, trying again on failure until the bound or a newer push for the same chat replaces it. */
  async function pushOne(
    /** @type {PhoneTarget} */ t,
    /** @type {NotifyEvent} */ event,
    /** @type {{ requestId: string, rev: number }} */ ids,
  ) {
    const state = /** @type {Record<string, string>} */ (STATE)[event.kind];
    const slot = `${t.hostId}\n${event.chatId}`;
    const mine = ++seq;
    newest.set(slot, mine);
    const ref = chatRef(t.pairId, event.chatId);
    const summary = event.card?.summary;
    // a clearing says nothing about the card: the relay titles it and forwards no blob, and the phone has nothing in it to open
    const clearing = event.kind === 'cleared';
    const sealed = clearing
      ? undefined
      : cards.seal({
          key: cards.cardKey(t.root),
          ref,
          requestId: ids.requestId,
          rev: ids.rev,
          detail: detail(),
          state,
          card: {
            machine: machineName(),
            tool: summary?.tool,
            line: summary?.line,
            stat: summary?.stat ? `${summary.stat.files} files +${summary.stat.added} -${summary.stat.removed}` : undefined,
            question: event.card?.cardKind === 'question',
          },
        });
    if (!clearing && !sealed) return;
    // a clearing is its own kind, never "done": the chat may still be running, and the relay replaces the waiting notification on every phone with a quiet "no longer needs you"
    const req = { pair: t.pairId, kind: clearing ? 'cleared' : 'needsYou', ref, ...(sealed && { sealed }) };
    for (let attempt = 0; ; attempt++) {
      try {
        const status = await send(t.hostId, req);
        // what the relay answered, so a push that went nowhere is told from one that was sent (no chat, card or text in it)
        report(`push ${req.kind} ${state}: ${status}`);
        if (FINAL.has(status)) return;
      } catch (error) {
        report(`push: ${/** @type {Error} */ (error).message}`);
        // a relay that does not know this kind (one that predates `cleared`) refuses it, and asking again cannot change that: the waiting notification stays, and no kind that claims something else is sent in its place
        if (/** @type {{ code?: string }} */ (error).code === 'bad_message') return;
      }
      const wait = RETRY_MS[attempt];
      if (wait === undefined || closed || newest.get(slot) !== mine) return;
      await new Promise((resolve) => {
        const timer = setTimer(() => {
          timers.delete(timer);
          resolve(undefined);
        }, wait);
        timers.set(timer, () => resolve(undefined));
      });
      // a card answered or paused while the relay was down needs no waiting push any more
      if (closed || newest.get(slot) !== mine) return;
    }
  }

  function fire(/** @type {NotifyEvent} */ event, /** @type {{ requestId: string, rev: number }} */ ids) {
    const linked = targets();
    if (event.kind === 'cleared') told.delete(event.chatId);
    else if (linked.length === 0) {
      // a Host that lost its relay link (reset, reinstalled) has no phone to push to, and nothing else says so
      skipped++;
      lastSkippedAt = now();
      report('push: no phone is linked to this Host, so a waiting card is not pushed');
      return Promise.resolve([]);
    } else {
      told.add(event.chatId);
      skipped = 0;
      lastSkippedAt = null;
    }
    return Promise.allSettled(linked.map((t) => pushOne(t, event, ids)));
  }

  /** The end of quiet hours: one catch-up for the newest held card, and the clearings that waited. */
  function flush() {
    quietTimer = null;
    if (closed) return;
    const until = quietUntil();
    if (until !== null) return schedule(until);
    const newestHeld = [...held.values()].pop();
    held.clear();
    const clears = [...clearLater];
    clearLater.clear();
    for (const chatId of clears) {
      const known = live.get(chatId);
      if (known && told.has(chatId)) void fire({ kind: 'cleared', chatId }, known.ids);
      live.delete(chatId);
    }
    if (newestHeld) void notify(newestHeld);
  }

  function schedule(/** @type {number} */ until) {
    if (quietTimer) return;
    quietTimer = setTimer(flush, Math.max(0, until - now()));
  }

  /** @param {NotifyEvent} event */
  function notify(event) {
    if (closed || !(event.kind in STATE)) return Promise.resolve();
    const quiet = quietUntil();
    const known = live.get(event.chatId);
    const ids = event.card ? { requestId: event.card.requestId, rev: event.card.rev ?? 0 } : known?.ids;
    if (!ids) return Promise.resolve();
    if (event.kind === 'cleared') {
      held.delete(event.chatId);
      if (!known || !told.has(event.chatId)) {
        // no phone was sent this card (it was held through quiet hours, or never raised): nothing to clear
        live.delete(event.chatId);
        clearLater.delete(event.chatId);
        return Promise.resolve();
      }
      if (quiet !== null) {
        clearLater.add(event.chatId);
        schedule(quiet);
        return Promise.resolve();
      }
      live.delete(event.chatId);
      return fire(event, ids);
    }
    const full = { ...event, card: event.card ?? known?.event.card };
    if (quiet !== null) {
      // quiet hours hold the push, not the clock: the engine's timers go on, and the newest card per chat is told at the end
      held.set(event.chatId, full);
      live.set(event.chatId, { event: full, ids });
      clearLater.delete(event.chatId);
      schedule(quiet);
      return Promise.resolve();
    }
    held.delete(event.chatId);
    clearLater.delete(event.chatId);
    live.set(event.chatId, { event: full, ids });
    return fire(full, ids);
  }

  return {
    notify,
    /** How many waiting cards found no phone linked, since a push last went out, and when the last did. */
    state: () => ({ skipped, lastSkippedAt }),
    close() {
      closed = true;
      for (const [timer, wake] of timers) {
        clearTimer(timer);
        wake();
      }
      timers.clear();
      if (quietTimer) clearTimer(quietTimer);
    },
  };
}
