// Push requests for the Mobile Remote feature: where the Mac would show an OS banner, one fixed-kind request per paired phone goes to a sink.
'use strict';
const { noteIgnored } = require('../ignored.cjs');
const { chatRef } = require('../../shared/remote/ref.mjs');
const { pushesToPhone } = require('../../shared/remote/pushSettings.mjs');
const { clock } = require('./ports/clock.cjs');

/** How long the Mac must have had no input before a push goes to the phone: Claude Code's own idle threshold (messageIdleNotifThresholdMs, 60 s) */
const AWAY_AFTER_MS = 60_000;
/** How often a "needs you" kept back because the person is at the Mac looks again */
const RECHECK_MS = 15_000;

/** The push kind of a banner: "needs you" kinds push as such, finished turns and goals as "done", the rest never push. */
function pushKindOf(kind, needs) {
  if (needs) return kind === 'momo' ? 'momoNeedsYou' : 'needsYou';
  return kind === 'turn' || kind === 'goal' ? 'done' : null;
}

/**
 * @param {object} o
 * @param {() => string[]} o.pairs the paired phones now
 * @param {(req: { pair: string, kind: string, ref: string, sealed?: string, card?: string, sealedBody?: string }) => void} o.sink `card`: MoMo's card the push is for, as an opaque handle (chatRef of the card id); a channel's card has `ref` = chatRef of the channel's id
 * @param {() => Record<string, boolean>} [o.getKinds] prefs.notifyKinds; a "finished" push needs its kind switched on explicitly (`true`): unset is off, as Claude pushes no finished chat unless asked
 * @param {() => number | null} [o.idleMs] how long the Mac has had no input (OS idle time); null when unknown, which counts as away
 * @param {(pair: string, ref: string, title: string) => string | null} [o.seal] the chat's title sealed for that phone (opt-in); never called for MoMo, whose pushes keep their fixed titles
 * @param {(chatId: string) => string} [o.bodyOf] MoMo's push body for the notice a chat raised (shared/momoNotices.mjs momoPushBody: the user's own routine's name after their opt-in, else ''); asked when the push is sent, so one that waited for the person to leave the Mac is built from the prefs and routine as they are then
 * @param {(pair: string, ref: string, text: string) => string | null} [o.sealBody] that body sealed for that phone; only MoMo's "needs you" is ever asked
 */
function createPushRequests({
  pairs,
  sink,
  seal = () => null,
  bodyOf = () => '',
  sealBody = () => null,
  getKinds = () => ({}),
  idleMs = () => null,
}) {
  const emit = (
    /** @type {string} */ pair,
    /** @type {string} */ kind,
    /** @type {string} */ ref,
    /** @type {string | null} */ sealed = null,
    /** @type {string | null} */ card = null,
    /** @type {string | null} */ sealedBody = null,
  ) => {
    try {
      sink({ pair, kind, ref, ...(sealed && { sealed }), ...(card && { card }), ...(sealedBody && { sealedBody }) });
    } catch (error) {
      noteIgnored('send a push request', error);
    }
  };
  const atMac = () => {
    const idle = idleMs();
    return typeof idle === 'number' && idle < AWAY_AFTER_MS;
  };
  /** @type {Map<string, any>} chat -> the timer of a "needs you" waiting for the person to leave the Mac */
  const waiting = new Map();
  const cancel = (/** @type {string} */ chatId) => {
    const timer = waiting.get(chatId);
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    waiting.delete(chatId);
  };
  /** The need still stands: say it once the person has left the Mac. Answering it (cancel) or a newer one for the chat replaces this. */
  const waitForAway = (/** @type {any} */ banner) => {
    cancel(banner.chatId);
    const timer = clock.setTimeout(() => {
      waiting.delete(banner.chatId);
      if (atMac()) return waitForAway(banner);
      send(banner);
    }, RECHECK_MS);
    timer.unref?.();
    waiting.set(banner.chatId, timer);
  };
  /** The sealed body of the MoMo notice a chat raised, or null: asked at send time. */
  const momoBody = (/** @type {string} */ pair, /** @type {string} */ ref, /** @type {string} */ chatId) => {
    const text = bodyOf(chatId);
    return text ? sealBody(pair, ref, text) : null;
  };
  const send = ({ kind, chatId, needs, chatTitle = '', cardId = '', channelId = '' }) => {
    const pushKind = pushKindOf(kind, needs);
    if (pushKind) {
      for (const pair of pairs()) {
        // MoMo's card goes as a handle only the phone can match against the cards it has, never its id; a channel's card names the channel the same way
        // (the handle of its id, which a phone that lists its channels recomputes: a phone never knows the chat ids), so a tap opens that channel on that card
        const ref = chatRef(pair, pushKind === 'momoNeedsYou' && channelId ? channelId : chatId);
        if (pushKind !== 'momoNeedsYou') emit(pair, pushKind, ref, seal(pair, ref, chatTitle));
        else emit(pair, pushKind, ref, null, cardId ? chatRef(pair, cardId) : null, momoBody(pair, ref, chatId));
      }
    }
  };
  return {
    /** The need was answered or opened: a push waiting for the person to leave the Mac is not sent. */
    cancel,
    onBanner(/** @type {any} */ banner) {
      const pushKind = pushKindOf(banner.kind, banner.needs);
      if (!pushKind) return;
      // a finished chat pushes only where its switch was turned on, not by default
      if (pushKind === 'done' && !pushesToPhone(getKinds(), banner.kind)) return;
      if (!atMac()) {
        if (pushKind !== 'done') cancel(banner.chatId);
        return send(banner);
      }
      // at the Mac the banner is enough: a finished chat says nothing more, a need is kept until the person leaves with it unanswered
      if (pushKind !== 'done') waitForAway(banner);
    },
    machineOffline(pairId) {
      emit(pairId, 'machineOffline', '');
    },
  };
}

module.exports = { createPushRequests, pushKindOf, AWAY_AFTER_MS, RECHECK_MS };
