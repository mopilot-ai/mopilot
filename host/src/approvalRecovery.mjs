// What a restart leaves of the cards of a turn: the ones the journal shows opened and never closed. They get `permissionCancelled { reason: 'host_restarted' }`, so every client draws them closed with the right words.

/**
 * The requests of a turn's cards that were opened and not closed, oldest first.
 * @param {{ event?: any }[]} items the chat's durable items
 * @param {string} turnId
 * @returns {string[]}
 */
function openCardsOf(items, turnId) {
  /** @type {Set<string>} */
  const open = new Set();
  for (const item of items) {
    const e = item?.event;
    if (!e) continue;
    if (e.kind === 'permission' && e.turnId === turnId && typeof e.requestId === 'string') open.add(e.requestId);
    else if (e.kind === 'question' && e.turnId === turnId && typeof e.question?.id === 'string') open.add(e.question.id);
    else if (e.kind === 'permissionCancelled') open.delete(e.requestId);
  }
  return [...open];
}

/**
 * A turn a restart cut off: each card it left open closes as `host_restarted` (before the turn's own end), and what the state lane kept of the chat is read.
 * @param {{ log: { items: (chatId: string) => { event?: any }[] }, approvals: { restore: (chatId: string) => void }, chatId: string, turnId: string, record: (chatId: string, event: object) => void }} o
 */
export function closeCutOffCards({ log, approvals, chatId, turnId, record }) {
  for (const requestId of openCardsOf(log.items(chatId), turnId))
    record(chatId, { kind: 'permissionCancelled', requestId, turnId, at: Date.now(), reason: 'host_restarted' });
  approvals.restore(chatId);
}
