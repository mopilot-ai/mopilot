// The rev each card was raised at, so an answer that carries an older rev than its card's is known to be for a card that is gone.

class CardLedger {
  constructor() {
    /** @type {Map<string, Map<string, number>>} chat -> card version -> the rev it was first seen at */
    this.byChat = new Map();
  }

  /** Records the cards up in a chat at `rev` (versions seen before keep their rev) and forgets the ones no longer up. */
  seen(/** @type {string} */ chatId, /** @type {string[]} */ versions, /** @type {number} */ rev) {
    const before = this.byChat.get(chatId) ?? new Map();
    const next = new Map(versions.map((v) => [v, before.get(v) ?? rev]));
    if (next.size) this.byChat.set(chatId, next);
    else this.byChat.delete(chatId);
  }

  /** A card seen by itself (an answer for one the ledger has no rev for): it counts as raised at `rev`. */
  note(/** @type {string} */ chatId, /** @type {string} */ version, /** @type {number} */ rev) {
    const cards = this.byChat.get(chatId) ?? new Map();
    if (!cards.has(version)) cards.set(version, rev);
    this.byChat.set(chatId, cards);
  }

  /** The rev a card was raised at, or undefined when it was never seen. */
  revOf(/** @type {string} */ chatId, /** @type {string} */ version) {
    return this.byChat.get(chatId)?.get(version);
  }

  forget(/** @type {string} */ chatId) {
    this.byChat.delete(chatId);
  }
}

module.exports = { CardLedger };
