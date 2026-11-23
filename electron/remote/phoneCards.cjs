// The cards a phone sees, placed: whether it can answer each (`where: 'phone'`) or only shows that the Mac waits for the user (`where: 'mac-only'` with `waitingCopy`), and the hand-offs only the Mac finishes (a sign-in, a check, a login sheet: app/phoneSteps.cjs) told to a chat's followers as they begin and end.

/** What a card that only the Mac finishes says when it does not word it itself. */
const MAC_WAITS = 'Waiting for you on your Mac';

/** A card as a phone gets it: where it is answered, and what a Mac-only one says. @param {any} card */
function placed(card) {
  const { macOnly, ...rest } = card;
  if (!card.inApp && !macOnly) return { ...rest, where: 'phone' };
  return {
    ...rest,
    where: 'mac-only',
    waitingCopy: typeof card.waitingCopy === 'string' && card.waitingCopy ? card.waitingCopy : MAC_WAITS,
  };
}

/** Which waiting cards a list holds. @param {any[]} cards */
const signature = (cards) => JSON.stringify(cards.map((c) => c.id));

/** The waiting cards of each followed chat, and the followers told when they change. */
class WaitingCards {
  /** @param {any} svc the RemoteService */
  constructor(svc) {
    this.svc = svc;
    /** @type {Map<string, string>} each chat's waiting cards as last told */
    this.told = new Map();
  }

  /** The chat's waiting cards now, each with its id as its version (it is raised once, and gone when its hand-off ends). @param {string} chatId */
  of(chatId) {
    return (this.svc.ops.waitingCards?.(chatId) ?? []).map((/** @type {any} */ c) => ({ ...c, version: c.id }));
  }

  /** The waiting cards the followers were just sent (a snapshot, a patch, cards.changed): the next change is against them. @param {string} chatId @param {any[]} cards */
  sent(chatId, cards) {
    this.told.set(chatId, signature(cards));
  }

  /** Hears the chats' calls change while phones are served; returns the unsubscribe. */
  follow() {
    return this.svc.ops.onCallChange?.((/** @type {string} */ chatId) => this.changed(chatId)) ?? (() => undefined);
  }

  /** A chat's calls changed: its followers get its cards again (cards.changed) when its waiting cards did. @param {string} chatId */
  changed(chatId) {
    const svc = this.svc;
    if (!svc.followers(chatId).length) return void this.told.delete(chatId);
    const now = signature(this.of(chatId));
    if (now === (this.told.get(chatId) ?? signature([]))) return;
    this.told.set(chatId, now);
    svc.cardUpdates.changed(chatId);
  }
}

module.exports = { placed, WaitingCards, MAC_WAITS };
