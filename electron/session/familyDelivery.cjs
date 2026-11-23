// Another session's message to a chat: an idle chat starts a turn with it, a running chat that can steer takes it into
// the current turn, and every other case keeps it in the chat's queue with the reason, so the sender's receipt is accurate.
const { busy } = require('./controllerEvents.cjs');
const { queueItem } = require('./queueItem.cjs');
const { traitsOf } = require('../harness/family.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */
/** @typedef {'awaiting_user' | 'switch_pending' | 'no_steer' | 'earlier_queued' | 'compaction' | 'voiceConversation'} FamilyWait */

/**
 * Why a running chat cannot take the message into its turn, or null when it can. The session store decides admission
 * (the same rule Send now applies to a message from a chat); the reason is only named from the state it read.
 * @param {ChatController} ctl
 * @param {string} chatId
 * @returns {FamilyWait | null}
 */
function whyWaits(ctl, chatId) {
  const s = ctl.state.get(chatId);
  const admitted =
    ctl.state.sendNowRoute(chatId, 'admit', { peer: true, peerSteers: () => ctl.peerCapabilities(chatId).steer }) === 'admit';
  if (!admitted) return s.turn === 'awaitingUser' ? 'awaiting_user' : s.pendingSwitch ? 'switch_pending' : 'no_steer';
  if (!traitsOf(ctl.ref(chatId).kind).steers) return 'no_steer';
  // it never steers past an older message another session sent that still waits here
  return s.queue.some((q) => q.sideSession) ? 'earlier_queued' : null;
}

/**
 * Deliver `item` (a message from a linked session) to `chatId`. Everything from the check to the steer runs without an
 * await, so the state it read is the state it acts on; the message is in the queue first, where the user can remove it,
 * and leaves it only when the harness takes the steer.
 * @this {ChatController}
 * @param {string} chatId
 * @param {any} item
 * @returns {Promise<{ started: boolean, steered?: boolean, queued?: boolean, held?: boolean, discarded?: boolean, waitingFor?: string, error?: string }>}
 */
function deliverFamily(chatId, item) {
  // a chat a Switch host is moving keeps it in the outbox with the rest (controller.send); the sender is told it is queued
  if (this.remote.moving?.(chatId))
    return this.send(chatId, item, null, true).then((r) =>
      r.action === 'queued' ? { started: false, queued: true, waitingFor: 'host' } : { started: false, error: r.error },
    );
  if (!busy(this.state.get(chatId))) return this.startOrKeep(chatId, queueItem(item, null));
  const waitingFor = whyWaits(this, chatId);
  const kept = this.send(chatId, item, null, true);
  if (waitingFor) return kept.then(() => ({ started: false, queued: true, waitingFor }));
  return Promise.resolve(/** @type {any} */ (this.sendNow(chatId, item.id, null, true))).then((result) => {
    switch (result.status) {
      case 'sent':
        return { started: true, steered: true };
      case 'held':
        return { started: false, held: true };
      case 'queued':
        return {
          started: false,
          queued: true,
          ...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      case 'missing':
        return { started: false, discarded: true };
      default:
        return { started: false, error: result.error || 'The harness did not accept the message.' };
    }
  });
}

module.exports = { deliverFamily, whyWaits };
