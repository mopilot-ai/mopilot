// The translated thread items paired phones follow: main feeds the item feed from the controller's live events while a transport is attached, and a snapshot's items come from it (else the panel's rows).
const { createItemFeed, originOf } = require('../harness/remoteItemFeed.cjs');
const { liveChatOf } = require('../remote/liveChat.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { phoneMessageItems } = require('./phoneMessageItems.cjs');
const { pictureAt } = require('../session/userImage.cjs');
const { userInput } = require('../../shared/userInput.mjs');
const { onHandoffItem } = require('../capabilities/browser/handoffNotes.cjs');

/**
 * @param {object} o
 * @param {() => InstanceType<typeof import('../remote/service.cjs').RemoteService>} o.service the panel's service (made after this)
 * @param {(chatId: string) => string} o.chatOf the chat a native session or thread belongs to
 * @param {(chatId: string, n: number) => Promise<unknown[]>} o.rows the chat's last `n` rows as the panel reads them; asked only when `n` is above 0
 * @param {(chatId: string) => boolean} [o.momoChat] whether the chat is MoMo's: its replies' Options lines go out as `options` (phoneMomoChat.cjs)
 * @param {(chatId: string) => string[]} [o.asked] what a phone sent to a side chat, oldest first (its turns have no user message of their own)
 * @param {() => Set<string>} [o.forks] the side chats a phone made (app/phoneSideChat.cjs): nothing of them is saved, so their events are kept here even while no phone is attached
 */
function openPhoneItems({ service, chatOf, rows, momoChat = () => false, forks = () => new Set(), asked = () => [] }) {
  const feed = createItemFeed({
    emit: (/** @type {any} */ event) =>
      service().onFeedEvent(
        /** @type {any} */ (
          event.items ? { ...event, items: phoneMessageItems(event.items, event.turnId, momoChat(event.chatId)) } : event
        ),
      ),
  });
  /** Whether the last event found remote control attached: once it has gone, no session's end reaches the feed's translators. */
  let followed = false;
  // a browser hand-off's line (handoffNotes.cjs) reaches phones following the chat at once, by its id; their history has it too
  onHandoffItem((chatId, item) => {
    try {
      if (service().attached) feed.appItem(chatId, item);
    } catch (error) {
      noteIgnored('show paired phones a browser hand-off', error);
    }
  });
  return {
    /** Saved history remains available even when the live ring contains only the end of the current turn. */
    async items(/** @type {string} */ chatId, /** @type {number} */ n) {
      const momo = momoChat(chatId);
      const before = feed.snapshot(chatId, 0).feedSeq;
      const history = n > 0 ? await rows(chatId, n) : [];
      // Copy live output and its cursor together after the asynchronous history read. History and live items are
      // separate collections: readers reconcile the provisional stream instead of replacing the saved conversation.
      const latest = feed.snapshot(chatId, n);
      const historyStale = latest.historyChangedAt > before || latest.liveUnavailable;
      return latest.liveItems.length
        ? {
            itemsShape: 'items',
            history,
            items: phoneMessageItems(latest.liveItems, latest.liveTurn?.id, momo),
            liveTurn: latest.liveTurn,
            feedSeq: latest.feedSeq,
            historyStale,
            liveUnavailable: latest.liveUnavailable,
          }
        : {
            itemsShape: 'rows',
            items: history,
            liveTurn: latest.liveTurn,
            feedSeq: latest.feedSeq,
            historyStale,
            liveUnavailable: latest.liveUnavailable,
          };
    },
    /**
     * A picture of a message the live feed shows (a turn running now, not saved yet): `{ url }` or `{ path }`, or null. The message is
     * named as its row names it (the item id, or a saved row's JSON id).
     */
    liveImage(/** @type {string} */ chatId, /** @type {string} */ itemId, /** @type {number} */ index) {
      let ref;
      try {
        ref = JSON.parse(itemId);
      } catch {
        return null;
      }
      const current = feed.snapshot(chatId, 200);
      if (!Array.isArray(ref) || ref.length !== 3 || ref[0] !== 'live' || ref[1] !== current.liveTurn?.id) return null;
      const item = current.liveItems.find((/** @type {any} */ x) => x?.type === 'userMessage' && x.id === ref[2]);
      return pictureAt(item, index);
    },
    /**
     * The turns of a chat nothing saves (a side chat), rebuilt from the items the feed holds, oldest first. A turn with no user message of its
     * own (Claude's stream has none) gets what the phone sent, matched from the end (the ring may have dropped the oldest turns). `exceptLive`
     * leaves out the turn the live items still carry, which a snapshot sends as live, but keeps that turn's question. Bounded by the ring;
     * gone with the chat (forget).
     * @param {string} chatId @param {{ exceptLive?: boolean }} [o]
     */
    turnsOf(chatId, { exceptLive = false } = {}) {
      const { entries, liveTurn, liveUnavailable } = feed.snapshot(chatId);
      /** @type {Map<string, any[]>} */
      const byTurn = new Map();
      for (const { item, turnId } of entries) byTurn.set(turnId ?? '', [...(byTurn.get(turnId ?? '') ?? []), item]);
      const turns = [...byTurn].map(([id, items]) => ({
        id,
        sourceSession: chatId,
        status: id === liveTurn?.id && liveTurn.status === 'inProgress' ? 'inProgress' : 'completed',
        items,
      }));
      const sent = asked(chatId);
      let next = sent.length;
      for (let at = turns.length - 1; at >= 0 && next > 0; at--) {
        if (turns[at].items.some((item) => item.type === 'userMessage')) continue;
        next -= 1;
        turns[at].items = [{ type: 'userMessage', id: `ask-${next}`, content: userInput(sent[next], []) }, ...turns[at].items];
      }
      // a live turn has the id of the turn it was made from (remoteItemFeed sets it only from a valid one)
      const live = exceptLive && liveTurn && !liveUnavailable ? liveTurn.id : null;
      return turns.flatMap((turn) => {
        if (turn.id !== live) return [turn];
        const questions = turn.items.filter((item) => String(item.id).startsWith('ask-'));
        return questions.length ? [{ ...turn, items: questions }] : [];
      });
    },
    /** A deleted chat's translators and ring go with it. An archived one keeps them: a turn it runs goes on to its end. */
    forget: (/** @type {string} */ chatId) => feed.forget(chatId),
    /** One raw event from the controller; a failure here is the phones', never the controller's. */
    live(/** @type {'codex' | 'claude' | 'acp'} */ family, /** @type {any} */ e) {
      try {
        const attached = service().attached;
        if (followed && !attached) feed.closeTranslators();
        followed = !!attached;
        // a side chat has no saved history to read back, so what it says is kept whether or not a phone is attached
        const kept = forks();
        const chatId = attached || kept.size ? liveChatOf(family, e, chatOf) : null;
        if (chatId && (attached || kept.has(chatId))) feed.push(chatId, family, e, originOf(family, e));
      } catch (error) {
        noteIgnored('translate a chat for paired phones', error);
      }
    },
  };
}

module.exports = { openPhoneItems };
