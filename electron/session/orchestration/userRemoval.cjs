// An item another session sent leaving a chat's queue without running (the user removed it, or its chat was archived or
// deleted): a message is recorded as removed for its sender with the reason, and the notes of a wake-up go back to the parent.
const { restoreNotes } = require('./journal.cjs');

/** Why a queued item left its chat's queue unrun; list_sessions tells the sender. */
const REASONS = ['user', 'archived', 'deleted'];

/** What a queued receipt tells the sender to do next (Claude Desktop: "Don't wait on it; check back if the outcome matters"). */
const QUEUED_NOTE =
  "It waits in that session's queue and runs when its current work ends; the user can remove it first, and list_sessions then lists it under removed_messages. Don't wait on it.";

/** Why a message that could have steered into the running turn waits instead (electron/session/familyDelivery.cjs). */
const WAIT_REASONS = {
  awaiting_user: 'it is waiting for the user',
  switch_pending: 'it is switching harness',
  no_steer: 'it cannot take a message during a turn',
  earlier_queued: 'an earlier message waits ahead of it',
  compaction: 'it is compacting',
  voiceConversation: 'a voice conversation is active there',
};

/** The queued receipt's note, naming why the message did not go into the running turn when that is known. @param {string} [waitingFor] */
const queuedNote = (waitingFor) => {
  const why = WAIT_REASONS[/** @type {keyof typeof WAIT_REASONS} */ (waitingFor)];
  return why ? QUEUED_NOTE.replace('runs when its current work ends', `runs when its current work ends (${why})`) : QUEUED_NOTE;
};

/**
 * The user took a wake-up out of its parent's queue before it ran. Its notes left the parent's record when the wake was
 * composed (service.cjs maybeWake), so they go back, and the wake no longer counts as one or holds the next one off.
 * @param {any} orch the Orchestrator
 * @param {string} id the wake-up's delivery id
 * @param {any} d its journal delivery
 * @param {string} reason why it left the queue
 */
function wakeRemoved(orch, id, d, reason) {
  // the removed wake is not waited on, whether or not the journal takes the notes back
  if (orch.waking.get(d.chatId) === id) orch.waking.delete(d.chatId);
  const restored = orch.safely('give back the notes of a removed wake-up', () =>
    orch.journal.change((data) => {
      data.deliveries[id].removedAt = orch.o.now();
      data.deliveries[id].removedReason = reason;
      restoreNotes(data, d.chatId, d.notes, d.at);
      const p = data.parents[d.chatId];
      p.wakes = Math.max(0, p.wakes - 1);
    }),
  );
  // a wakeable note that came while this wake waited was held back by it; the restored ones wake nobody
  orch.o.defer(() => orch.maybeWake(d.chatId));
  return restored;
}

/**
 * The user took a message another session sent out of its recipient's queue before it ran. It stays in the journal as
 * removed, so its sender finds that out from list_sessions (Claude Desktop ends it as undelivered: "removed from that
 * session's queue before it ran").
 * @param {any} orch the Orchestrator
 * @param {string} id the message's delivery id
 * @param {any} _d its journal delivery
 * @param {string} reason why it left the queue
 */
function messageRemoved(orch, id, _d, reason) {
  // the item is already out of the queue: a journal that cannot record it must not turn that into a failure
  return orch.safely('record a removed message', () =>
    orch.journal.change((data) => {
      data.deliveries[id].removedAt = orch.o.now();
      data.deliveries[id].removedReason = reason;
    }),
  );
}

/**
 * What the user taking each kind of queued delivery out of its chat's queue does. Every kind of delivery the journal holds
 * has an entry (tests/queuedDeliveryRemoval.invariant.test.ts): a payload moved out of the journal when the item was
 * composed goes back, one the journal still holds stays.
 * @type {Record<string, (orch: any, id: string, d: any, reason: string) => boolean>}
 */
const ON_REMOVED = {
  message: messageRemoved,
  wake: wakeRemoved,
  // its task is kept whole in the delivery, so nothing is lost; the session simply has not started
  brief: () => false,
};

/**
 * An item another session sent left `chatId`'s queue before it ran. Only the first removal counts. Every path that takes
 * such an item out of a queue without running it goes through here (the user's removal, an archived or deleted chat).
 * @param {{ journal: any, waking: Map<string, string>, maybeWake: (chatId: string) => boolean, o: { now: () => number, defer: (fn: () => void) => void }, safely: (what: string, fn: () => void) => boolean }} orch the Orchestrator
 * @param {string} chatId the chat whose queue it left
 * @param {{ sideSession?: { id: string } }} item the queued item
 * @param {'user' | 'archived' | 'deleted'} [reason]
 */
function queuedRemoved(orch, chatId, item, reason = 'user') {
  const id = item?.sideSession?.id;
  if (!id) return false;
  const d = orch.journal.data.deliveries[id];
  if (!d || d.chatId !== chatId || d.removedAt || !Object.hasOwn(ON_REMOVED, d.kind)) return false;
  return ON_REMOVED[d.kind](orch, id, d, reason);
}

/** The journal's own waiting entries for `chatId` (scheduler.cjs), shaped as queue items. */
const journalQueued = (orch, chatId) =>
  orch.journal.data.queue.filter((e) => e.chatId === chatId).map((e) => ({ sideSession: { id: e.id } }));

/**
 * A chat's whole queue goes with it (deleted) or its waiting entries are dropped (archived): each item another session
 * sent is recorded for its sender. Items without a side-session id are the user's own and are skipped.
 * @param {any} orch the Orchestrator
 * @param {string} chatId
 * @param {{ sideSession?: { id: string } }[]} items
 * @param {'archived' | 'deleted'} reason
 */
function queueDropped(orch, chatId, items, reason) {
  for (const item of items) queuedRemoved(orch, chatId, item, reason);
}

/**
 * Remove a queued item for the user. What another session sent is settled in the linked-session journal (ON_REMOVED: a
 * message is recorded as removed for its sender, a wake-up gives its notes back); a chat with no linked sessions records nothing.
 * @param {{ controller: { removeQueued: (chatId: string, qid: string) => any }, orchestrator?: { queuedRemoved: (chatId: string, item: any) => boolean } }} live
 * @param {string} chatId
 * @param {string} qid
 * @returns {boolean} whether the item was in the queue
 */
function removeQueuedForUser(live, chatId, qid) {
  const item = live.controller.removeQueued(chatId, qid);
  if (item) live.orchestrator?.queuedRemoved(chatId, item);
  return !!item;
}

module.exports = { removeQueuedForUser, queuedRemoved, queueDropped, journalQueued, REASONS, ON_REMOVED, QUEUED_NOTE, queuedNote };
