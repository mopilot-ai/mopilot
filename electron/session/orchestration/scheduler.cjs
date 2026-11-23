// Linked-chat delivery has no application-wide parallel cap. Busy recipients retain their ordered messages;
// the legacy persisted queue drains when each recipient is idle, independently of other working chats.
const { addNote } = require('./journal.cjs');
const { nameOf, liveSelfOrAbove } = require('./family.cjs');
const { queuedRemoved } = require('./userRemoval.cjs');
const { sendChild, sendingChild, pendingChild, queuedChild, currentChildInput } = require('./childDelivery.cjs');

/** Legacy export: global child concurrency is unbounded. */
const DEFAULT_CAP = Infinity;
/** Legacy export retained for readers of older scheduler contracts. */
const MAX_CAP = Infinity;

/** Persisted old preferences cannot restore a global capacity queue. */
function capOf(_prefs = null) {
  return Infinity;
}

/** Whether a chat is working: a turn running, or waiting on the user mid-turn. */
const working = (orch, chatId) => {
  const { turn } = orch.o.controller.state.get(chatId);
  return turn === 'running' || turn === 'awaitingUser';
};
const waiting = (orch, chatId) =>
  working(orch, chatId) || sendingChild(orch, chatId) || orch.o.controller.state.get(chatId).queue.length > 0;

/** A running child that takes a message into its turn (nothing sending to it, no earlier message waiting): it is not waited for. */
const steersIn = (orch, chatId) =>
  !!orch.o.deliverFamily &&
  orch.o.controller.state.get(chatId).turn === 'running' &&
  !sendingChild(orch, chatId) &&
  orch.o.controller.familyWait?.(chatId) === null;

/** Linked chats working now, the user's own turns in them included: of the chats main has a session state for. */
function runningChildren(orch) {
  return orch.o.controller.state.all().filter((id) => orch.journal.child(id) && working(orch, id)).length;
}

/** Where a chat's first waiting item stands in the queue (1 is next), or 0 when nothing of it waits. */
function queuePosition(orch, chatId) {
  return orch.journal.data.queue.findIndex((e) => e.chatId === chatId) + 1;
}

/**
 * Send `item` to the linked child `chatId` now when the recipient is idle and nothing waits ahead of it;
 * otherwise it joins the end of the queue. Resolves with the send's result, or {queued, position}.
 * @param {any} orch the Orchestrator
 * @param {string} chatId
 * @param {{ id: string, text: string, sideSession: { id: string }, attachments: [], opts: { human: false } }} item
 */
async function deliverToChild(orch, chatId, item) {
  const { journal, o } = orch;
  const pending = pendingChild(orch, chatId, item.id);
  if (pending) return pending;
  if (queuedChild(orch, chatId, item.id) || currentChildInput(orch, chatId, item.id)) return { queued: true };
  if (journal.data.queue.some((entry) => entry.chatId === chatId && entry.id === item.id))
    return { queued: true, position: queuePosition(orch, chatId) };
  if (!journal.data.queue.length && (steersIn(orch, chatId) || !waiting(orch, chatId)) && runningChildren(orch) < capOf(o.prefs()))
    return sendChild(orch, chatId, item);
  journal.change((d) => d.queue.push({ id: item.id, chatId, item, at: o.now() }));
  pump(orch);
  const position = queuePosition(orch, chatId);
  // Leaving the journal queue only means pump dispatched it; native acceptance may still be pending.
  return { queued: true, ...(position ? { position } : {}) };
}

/**
 * Start what waits, first in first out, while slots are free: each item goes once its chat is idle (a busy chat's
 * items wait without holding up the others). An item for a chat that is gone or archived is dropped, and its parent
 * is told in a note, never silently.
 * @param {any} orch
 */
function pump(orch) {
  const { journal, o } = orch;
  if (orch.unavailable || !journal.data.queue.length) return;
  let free = capOf(o.prefs()) - runningChildren(orch);
  const send = [];
  const dropped = [];
  const busy = new Set();
  for (const entry of journal.data.queue) {
    // gone: deleted, or no longer a linked chat (a new chat with no saved record yet is still here)
    if (!journal.child(entry.chatId) || o.chats.isDeleted(entry.chatId) || orch.archived(entry.chatId)) dropped.push(entry);
    else if (free > 0 && !busy.has(entry.chatId) && !waiting(orch, entry.chatId)) {
      send.push(entry);
      busy.add(entry.chatId);
      free--;
    } else busy.add(entry.chatId);
  }
  if (!send.length && !dropped.length) return;
  const gone = new Set([...send, ...dropped].map((e) => e.id));
  // out of the queue before it goes: a send interrupted by a quit is not sent twice
  const committed = orch.safely('take items off the session queue', () =>
    journal.change((d) => {
      d.queue = d.queue.filter((e) => !gone.has(e.id));
      for (const e of dropped) {
        const parentId = d.children[e.chatId]?.parentId;
        if (!parentId) continue;
        addNote(d, liveSelfOrAbove(journal, parentId, orch.archived), {
          childId: e.chatId,
          body: `A message waiting for the session ${nameOf(journal, e.chatId)} (${e.chatId}) was not sent: that chat is archived or gone.`,
          at: o.now(),
          wakes: false,
        });
      }
    }),
  );
  if (!committed) return;
  for (const e of dropped) queuedRemoved(orch, e.chatId, { sideSession: { id: e.id } }, orch.archived(e.chatId) ? 'archived' : 'deleted');
  for (const e of send)
    void sendChild(orch, e.chatId, {
      ...e.item,
      sideSession: { id: e.item.id },
      attachments: e.item.attachments ?? [],
      opts: { ...e.item.opts, human: false },
    }).then((result) => {
      if (!result.error) return;
      orch.safely('report a linked message delivery failure', () =>
        journal.change((data) => {
          const parentId = data.children[e.chatId]?.parentId;
          if (parentId)
            addNote(data, liveSelfOrAbove(journal, parentId, orch.archived), {
              childId: e.chatId,
              body: `A message for ${nameOf(journal, e.chatId)} (${e.chatId}) did not start: ${result.error}`,
              at: o.now(),
              wakes: false,
            });
        }),
      );
    });
}

module.exports = { deliverToChild, pump, capOf, runningChildren, queuePosition, DEFAULT_CAP, MAX_CAP };
