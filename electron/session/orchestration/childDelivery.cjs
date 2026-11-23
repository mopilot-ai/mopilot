// A created linked child keeps its complete input after rejection; pending native acceptance is never dispatched twice.
const { queueItem } = require('../queueItem.cjs');
const { messageOf } = require('../../ignored.cjs');

const queued = (orch, chatId, id) => orch.o.controller.state.get(chatId).queue.some((item) => item.id === id);
const currentInput = (orch, chatId, id) => {
  const state = orch.o.controller.state.get(chatId);
  return (
    orch.o.controller.rt(chatId).inputToken === `pending-${id}` &&
    (state.turn === 'running' || state.turn === 'awaitingUser') &&
    !!state.activeTurn
  );
};
const refused = (error) => ({ started: false, error: messageOf(error) });
const sendingChild = (orch, chatId) => orch.childDeliveryChats?.has(chatId) === true;
const deliveryKey = (orch, chatId, id) =>
  JSON.stringify([chatId, id, orch.o.controller.ref(chatId).key, orch.o.chats.archiveEpoch?.(chatId)]);
const pendingChild = (orch, chatId, id) => orch.childDeliveries?.get(deliveryKey(orch, chatId, id));

/** The controller owns retryable input. A journal fallback retains it if that queue's bookkeeping itself fails. */
function keep(orch, chatId, item, current, error) {
  if (!current()) return refused('The session changed before its message could be kept; nothing was sent to its replacement.');
  if (queued(orch, chatId, item.id) || currentInput(orch, chatId, item.id)) return { queued: true, error };
  try {
    orch.o.controller.queueFirst(chatId, queueItem(item, item.origin), true);
    if (queued(orch, chatId, item.id)) return { queued: true, error };
  } catch (keeperError) {
    error = `${error}; ${messageOf(keeperError)}`;
  }
  if (queued(orch, chatId, item.id)) return { queued: true, error };
  try {
    orch.journal.change((data) => {
      if (!data.queue.some((entry) => entry.chatId === chatId && entry.id === item.id))
        data.queue.push({ id: item.id, chatId, item, at: orch.o.now() });
    });
    return { queued: true, error };
  } catch (keeperError) {
    return refused(`${error}; the message could not be kept: ${messageOf(keeperError)}`);
  }
}

/** Normalize every sender outcome after allocation, so retry never allocates a replacement child for a send failure. */
function sendChild(orch, chatId, item) {
  const { controller, chats } = orch.o;
  let native, epoch;
  try {
    native = controller.ref(chatId).key;
    epoch = chats.archiveEpoch?.(chatId);
  } catch (error) {
    return Promise.resolve(refused(error));
  }
  const current = () => {
    try {
      return (
        !chats.isDeleted(chatId) &&
        !orch.archived(chatId) &&
        controller.ref(chatId).key === native &&
        chats.archiveEpoch?.(chatId) === epoch
      );
    } catch {
      return false;
    }
  };
  if (!current()) return Promise.resolve(refused('This session is archived or gone; its message was not sent.'));
  if (queued(orch, chatId, item.id)) return Promise.resolve({ queued: true });
  const pending = (orch.childDeliveries ??= new Map());
  const key = deliveryKey(orch, chatId, item.id);
  const before = pending.get(key);
  if (before) return before;
  if (currentInput(orch, chatId, item.id)) return Promise.resolve({ queued: true, acceptancePending: true });
  let sent;
  const sending = (orch.childDeliveryChats ??= new Map());
  sending.set(chatId, (sending.get(chatId) ?? 0) + 1);
  // Invoke synchronously: the legacy pump reserves one recipient before it dispatches the next one.
  try {
    // a running child that can steer takes it into its turn (the app wires deliverFamily); tests and other seams use send
    sent = (orch.o.deliverFamily ?? orch.o.send)(chatId, item);
  } catch (error) {
    sent = Promise.reject(error);
  }
  const operation = Promise.resolve(sent)
    .then(
      (result) => {
        if (result?.action === 'queued' || result?.queued) return { ...result, queued: true };
        if (result?.started || result?.held) return result;
        if (result?.discarded) return { ...result, started: false, error: 'This message was cancelled before delivery.' };
        return keep(orch, chatId, item, current, result?.error ?? 'The harness did not accept the message.');
      },
      (error) => keep(orch, chatId, item, current, messageOf(error)),
    )
    .catch((error) => refused(`The message could not be kept: ${messageOf(error)}`))
    .finally(() => {
      pending.delete(key);
      const count = sending.get(chatId) - 1;
      if (count) sending.set(chatId, count);
      else sending.delete(chatId);
    });
  pending.set(key, operation);
  return operation;
}

module.exports = { sendChild, sendingChild, pendingChild, queuedChild: queued, currentChildInput: currentInput };
