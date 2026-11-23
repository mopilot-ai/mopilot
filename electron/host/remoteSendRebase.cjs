// What happens to the messages kept for a chat's old owner when its move ends: they go to the new owner (or to this Mac's controller when the chat came back), in order and once.
const { LOCAL_HOST_ID } = require('./ownership.cjs');

/**
 * @param {object} o
 * @param {any} o.outbox
 * @param {(chatId: string) => { hostId: string, epoch: number }} o.ownerOf
 * @param {Set<string>} o.moved messages flagged as waiting for the continue dialog
 * @param {Map<string, string | null>} o.moving chats a Switch host is moving now, with the machine they move to
 * @param {(chatId: string) => Promise<{ stopped: string | null }>} o.drain
 * @param {((chatId: string, item: any) => Promise<any>) | undefined} o.localSend delivers a message to a chat that runs here
 * @param {(chatId: string) => void} o.project
 * @param {(error: Error) => void} o.report
 * @param {(chatId: string, key: string, message: string | null) => void} o.refuse a message that stays kept with a cause (null: its delivery to the controller was never confirmed): it waits for the person
 */
function createRebase({ outbox, ownerOf, moved, moving, drain, localSend, project, report, refuse }) {
  /**
   * The chat was continued back to this Mac: its kept messages go to the local controller in order, each acked once taken. A message the controller
   * refuses stays kept (with the ones behind it). The bubble here is dropped only after the ack.
   * @param {string} chatId
   */
  /** One delivery per chat at a time: a restart's sweep and the end of the move never both send the same message. @type {Map<string, Promise<void>>} */
  const delivering = new Map();
  /** @param {string} chatId @param {(e: any) => boolean} [only] the entries to deliver (all queued ones by default) */
  function deliverHere(chatId, only = () => true) {
    // the move that holds the chat is not over: what is kept is for whoever owns the chat after it
    if (moving.has(chatId)) return Promise.resolve();
    const running = delivering.get(chatId);
    if (running) return running;
    const run = deliverNow(chatId, only).finally(() => delivering.delete(chatId));
    delivering.set(chatId, run);
    return run;
  }

  /** The person chose to send a message again whose delivery was never confirmed. @param {string} chatId @param {string} key */
  function confirmHere(chatId, key) {
    outbox.annotate(chatId, key, { delivering: false });
    return deliverHere(chatId);
  }

  /** @param {string} chatId @param {(e: any) => boolean} only */
  async function deliverNow(chatId, only) {
    try {
      // read again before every message: one kept meanwhile is sent in its turn
      const next = () => (moving.has(chatId) ? undefined : outbox.pending(chatId).find((x) => x.state === 'queued' && only(x)));
      for (let e = next(); e; e = next()) {
        const options = /** @type {any} */ (e.options);
        // handed over before and never acked (the app stopped in between): the controller cannot say whether it took it, so it is not sent a second time on its own
        if (options.delivering) {
          refuse(chatId, e.key, null);
          break;
        }
        // the message goes under its own id, so what the controller records matches the row that is acked
        const item = options.item;
        outbox.annotate(chatId, e.key, { delivering: true });
        let receipt;
        try {
          receipt = await localSend?.(chatId, item);
        } catch (error) {
          // it never took it: nothing was delivered
          outbox.annotate(chatId, e.key, { delivering: false });
          throw error;
        }
        if (!receipt || receipt.action === 'failed') {
          outbox.annotate(chatId, e.key, { delivering: false });
          if (receipt?.error) report(new Error(receipt.error));
          // it stays kept, saying why; Send now tries again
          refuse(chatId, e.key, receipt?.error || 'This chat could not take the message.');
          break;
        }
        outbox.ack(chatId, [e.key]);
      }
      project(chatId);
    } catch (error) {
      report(/** @type {Error} */ (error));
    }
  }

  /**
   * What waited for the chat's old owner goes to the new one. Resolves with how the drain at the new owner ended, none when nothing waited or the chat is here.
   * @param {string} chatId
   */
  async function rebaseChat(chatId) {
    // nothing kept for this chat: nothing to move
    if (!outbox.pending(chatId).length) return undefined;
    const owner = ownerOf(chatId);
    outbox.rebase(chatId, owner.epoch);
    for (const e of outbox.pending(chatId)) moved.delete(e.key);
    if (owner.hostId !== LOCAL_HOST_ID) {
      let result = await drain(chatId);
      // a drain that began at the old owner and joined this one ended "moved" with its message flagged: nothing is waiting for the dialog now, so it goes to the new owner
      if (result.stopped === 'stale_epoch') {
        for (const e of outbox.pending(chatId)) moved.delete(e.key);
        result = await drain(chatId);
      }
      return result;
    }
    await deliverHere(chatId);
    return undefined;
  }

  /**
   * What was kept for a move that does not run any more (the app restarted in the middle of it) belongs to whoever owns the chat now: rebased, and delivered here when the chat runs here (a machine's drain follows).
   * @param {string} chatId
   */
  async function settleHeld(chatId) {
    if (moving.has(chatId)) return;
    const owner = ownerOf(chatId);
    const held = (/** @type {any} */ e) => e.options?.held === true;
    if (!outbox.pending(chatId).some((e) => e.state === 'queued' && held(e))) return;
    outbox.rebase(chatId, owner.epoch, held);
    for (const e of outbox.pending(chatId).filter(held)) moved.delete(e.key);
    // only what was kept for the move: older messages waiting for the continue dialog are not sent by a restart
    if (owner.hostId === LOCAL_HOST_ID) await deliverHere(chatId, held);
  }

  /** The chat's kept messages show their new state; a chat with none shows nothing (no queue is touched for it). @param {string} chatId */
  function show(chatId) {
    try {
      if (outbox.pending(chatId).length) project(chatId);
    } catch (error) {
      report(/** @type {Error} */ (error));
    }
  }

  /** A Switch host starts moving the chat to `to`: what is sent to it from now on is kept until `endMove`. @param {string} chatId @param {string | null} [to] */
  function holdMove(chatId, to = null) {
    moving.set(chatId, to);
    show(chatId);
  }

  /** The move ended, done or refused: what was kept goes to the chat's owner now, in order and once. @param {string} chatId */
  async function endMove(chatId) {
    moving.delete(chatId);
    try {
      await rebaseChat(chatId);
    } finally {
      show(chatId);
    }
  }

  return { rebaseChat, holdMove, endMove, settleHeld, confirmHere };
}

module.exports = { createRebase };
