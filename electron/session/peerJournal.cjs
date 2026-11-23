// The peer message journal's shape (peer-messages.json): what a loaded journal must hold before messaging trusts it.

/** Every delivery state a journaled message can be in, the receiving chat's hold's included (peerHold.cjs). */
const DELIVERIES = new Set([
  ...['accepted', 'queued', 'submitting', 'delivered', 'blocked', 'failed', 'cancelled', 'uncertain'],
  ...['held', 'declined', 'expired'],
]);
const REPLIES = new Set(['notRequested', 'awaiting', 'received', 'timedOut']);

/** True when `data` is a journal this version reads: anything else disables messaging and keeps the file intact. */
function validJournal(/** @type {any} */ data) {
  return !!(
    data &&
    data.schemaVersion === 1 &&
    Array.isArray(data.messages) &&
    data.messages.every(
      (/** @type {any} */ m) =>
        m &&
        typeof m.id === 'string' &&
        typeof m.sourceChatId === 'string' &&
        typeof m.targetChatId === 'string' &&
        typeof m.body === 'string' &&
        DELIVERIES.has(m.delivery) &&
        REPLIES.has(m.reply) &&
        typeof m.dedupeKey === 'string' &&
        typeof m.fingerprint === 'string' &&
        Number.isFinite(m.createdAt),
    ) &&
    new Set(data.messages.map((/** @type {any} */ m) => m.id)).size === data.messages.length &&
    (data.pausedChats === undefined ||
      (Array.isArray(data.pausedChats) && data.pausedChats.every((/** @type {any} */ id) => typeof id === 'string')))
  );
}

module.exports = { validJournal };
