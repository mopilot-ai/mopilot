// Where a banner the Mac shows also becomes a push request to the relay: the notifier's onBanner hook (so quiet hours, the Notifications mode, per-kind switches and MoMo's rule have already decided) feeds one {pair, kind, ref} per paired phone into the running relay client. Nothing is sent while Mobile Remote is off or has no paired phone; a relay that is down loses the push, never the banner.
'use strict';
const { noteIgnored } = require('../ignored.cjs');
const { createPushRequests } = require('../platform/notifyPush.cjs');
const { chatRef } = require('../../shared/remote/ref.mjs');

/**
 * @param {object} o
 * @param {() => Record<string, boolean>} [o.getKinds] prefs.notifyKinds
 * @param {() => number | null} [o.idleMs] ms since the Mac's last input
 * @param {(chatId: string) => boolean} [o.hostPushes] true when the chat's Host sends its own approval pushes to a phone (see hostSendsPush): the Mac then sends none for it, so the phone gets one notification, not two; banners on the Mac stay
 * @param {() => ({ devices: { list(): { pairId: string }[] } | null, pushTitles?: { seal(pair: string, ref: string, title: string): string | null, sealBody(pair: string, ref: string, text: string): string | null } | null, pushRequest(req: { pair: string, kind: string, ref: string, sealed?: string, card?: string, sealedBody?: string }): Promise<string> }) | null | undefined} o.remote the live Mobile Remote (live.remote)
 * @param {(chatId: string) => string} [o.bodyOf] MoMo's push body for a notice the chat raised ('' for none; electron/app/momoBackground.cjs)
 */
function createPushBridge({ remote, getKinds, idleMs, bodyOf, hostPushes = () => false }) {
  const pairs = () =>
    [
      ...new Set(
        remote()
          ?.devices?.list()
          .map((d) => d.pairId),
      ),
    ].filter(Boolean);
  const requests = createPushRequests({
    pairs,
    getKinds,
    idleMs,
    seal: (pair, ref, title) => remote()?.pushTitles?.seal(pair, ref, title) ?? null,
    bodyOf,
    sealBody: (pair, ref, text) => remote()?.pushTitles?.sealBody(pair, ref, text) ?? null,
    sink: (req) => {
      remote()
        ?.pushRequest(req)
        .catch((error) => noteIgnored('send a push request to the relay', error));
    },
  });
  /** @type {Map<string, Set<string>>} per batch held through quiet hours: the phones that already have it, until all of them do */
  const told = new Map();
  /** The one-pusher rule (P4): a "needs you" for a chat whose Host pushes is not sent from here. A finished chat is not covered by the Host's pushes and goes as before. */
  const needsFromHost = (/** @type {any} */ banner) => !!banner?.needs && hostPushes(banner.chatId) === true;
  return {
    ...requests,
    onBanner(/** @type {any} */ banner) {
      if (needsFromHost(banner)) return requests.cancel(banner.chatId);
      return requests.onBanner(banner);
    },
    /**
     * The chats held through quiet hours (quietHold.cjs): one fixed-title "needs you" per paired phone, naming the newest chat by its opaque ref and carrying no title. True when every phone has it (or none is paired); false while Mobile Remote is not running or a phone's push did not go, so the caller tries again, and a phone that has it is not sent it twice.
     * @param {{ chatId: string, at: number }} held
     */
    async catchUp({ chatId, at }) {
      if (hostPushes(chatId)) return true;
      const live = remote();
      // not up yet (starting, or off): the paired phones are not known, so it is not "nobody to tell"
      if (!live?.devices) return false;
      const batch = `${chatId}:${at}`;
      const have = told.get(batch) ?? new Set();
      const todo = pairs().filter((pair) => !have.has(pair));
      const sent = await Promise.allSettled(todo.map((pair) => live.pushRequest({ pair, kind: 'needsYou', ref: chatRef(pair, chatId) })));
      sent.forEach((r, i) => {
        // 'failed' is the provider failing; the rest (sent, suppressed by the merge rule, no token, disabled) are final
        if (r.status === 'fulfilled' && r.value !== 'failed') have.add(todo[i]);
      });
      const waiting = pairs().some((pair) => !have.has(pair));
      if (waiting) {
        told.set(batch, have);
        // a few batches at most are remembered
        if (told.size > 20) told.delete(/** @type {string} */ (told.keys().next().value));
      } else told.delete(batch);
      return !waiting;
    },
  };
}

/**
 * Whether a Host sends the push for its chats: it agrees on `approvals2` and holds at least one phone enrollment (`host.relayStatus` links that name a client).
 * @param {{ features?: string[], links?: { client?: string }[] } | null | undefined} host
 */
function hostSendsPush(host) {
  return !!host?.features?.includes('approvals2') && !!host.links?.some((l) => l.client);
}

module.exports = { createPushBridge, hostSendsPush };
