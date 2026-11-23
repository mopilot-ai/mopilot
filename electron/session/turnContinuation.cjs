// Joins an account move with its original turn's actual completion, retiring automatic continuations when the chat changes.
const { addHook } = require('./hookChain.cjs');
const { guardInput } = require('./contract/inputGuard.cjs');
const { queueItem } = require('./queueItem.cjs');
const { ignoring } = require('../ignored.cjs');
const { folderMutation } = require('./folderMutation.cjs');

class TurnContinuations {
  constructor(controller, signal) {
    this.controller = controller;
    this.signal = signal;
    this.pending = new Map();
    this.completed = new WeakMap();
    addHook(controller, 'onFinished', ({ chatId, turnId }) => {
      const completion = { turnId };
      this.completed.set(controller.rt(chatId), completion);
      const owner = this.pending.get(chatId);
      if (!owner) return;
      this.pending.delete(chatId);
      if (owner.turnId !== turnId) return;
      owner.ended = true;
      owner.completion = completion;
      this.release(owner);
    });
    const retire = (chatId) => {
      this.pending.delete(chatId);
      this.completed.set(controller.rt(chatId), {});
    };
    addHook(controller, 'onCrash', retire);
    addHook(controller, 'onInterrupt', retire);
    signal.addEventListener('abort', () => this.pending.clear(), { once: true });
  }

  prepare(threadId, turnId) {
    const c = this.controller;
    const chatId = c.chatOf(threadId);
    if (this.signal.aborted || !turnId || !c.isCurrentSource(chatId, { kind: 'codex', key: threadId })) return () => undefined;
    const s = c.state.get(chatId);
    if (s.activeTurn?.id !== turnId) return () => undefined;
    const runtime = c.rt(chatId);
    const owner = {
      chatId,
      threadId,
      turnId,
      runtime,
      attempt: runtime.startAttempt,
      stops: runtime.stops ?? 0,
      moved: false,
      ended: false,
      released: false,
    };
    // A repeated preparation for the same turn replaces only its automatic continuation.
    const previous = this.pending.get(chatId);
    if (previous) previous.released = true;
    this.pending.set(chatId, owner);
    return () => {
      owner.moved = true;
      this.release(owner);
    };
  }

  release(owner) {
    if (!owner.moved || !owner.ended || owner.released) return;
    owner.released = true;
    // The controller drains already queued user input synchronously after its finish hooks.
    queueMicrotask(async () => {
      const c = this.controller;
      const mutation = folderMutation(c, owner.chatId);
      if (mutation) await mutation;
      const sourceCurrent = () =>
        !this.signal.aborted &&
        c.chats.records.has(owner.chatId) &&
        !c.chats.isDeleted(owner.chatId) &&
        !c.chats.isDeleted(owner.threadId) &&
        c.isCurrentSource(owner.chatId, { kind: 'codex', key: owner.threadId });
      if (!sourceCurrent() || c.rt(owner.chatId) !== owner.runtime) return;
      const r = owner.runtime;
      const s = c.state.get(owner.chatId);
      const owned = () =>
        sourceCurrent() && c.rt(owner.chatId) === r && this.completed.get(r) === owner.completion && (r.stops ?? 0) === owner.stops;
      if (!owned() || r.startAttempt !== owner.attempt || s.turn !== 'idle' || s.queue.length || s.pendingSwitch) return;
      const item = queueItem({ text: 'Continue where you left off.', attachments: [], opts: {} }, null);
      /** @type {{ attempt: unknown, token: string | null } | null} */
      let dispatch = null;
      const current = () => owned() && (!dispatch || (r.startAttempt === dispatch.attempt && r.token === dispatch.token));
      guardInput(item, current);
      // Automatic input never becomes a queued human draft after Stop or a refused native start.
      const sending = c.start(owner.chatId, item);
      const startedAttempt = { attempt: r.startAttempt, token: r.token };
      dispatch = startedAttempt;
      const failed = (result) => {
        const completion = this.completed.get(r);
        if (
          !result.started &&
          sourceCurrent() &&
          c.rt(owner.chatId) === r &&
          r.startAttempt === startedAttempt.attempt &&
          (r.stops ?? 0) === owner.stops &&
          r.token === null &&
          (completion?.turnId === startedAttempt.token || completion === owner.completion) &&
          c.state.get(owner.chatId).turn === 'idle'
        )
          c.state.patch(owner.chatId, {
            turn: 'crashed',
            crashed: 'Could not continue after switching accounts. Send a message to try again.',
          });
      };
      sending.then(failed).catch(ignoring('report an account continuation failure'));
    });
  }
}

module.exports = { TurnContinuations };
