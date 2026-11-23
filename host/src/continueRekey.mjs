// A continue begun before the Host named chats by one spelling (#5160) left its owner record, epoch and pending handoff under the app's spelling of the chat's id (`acp:host-codex:<id>`): they are moved to the Host's (`<id>`) at start, so an upgrade in the middle of a move does not strand it. Nothing here can stop the Host from starting: what cannot be moved is reported.
import { hostChatId } from '../../shared/host/chatIds.mjs';

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./owners.mjs').createOwnerStore>} o.owners
 * @param {{ admit: (chatId: string, epoch: number) => unknown, current: (chatId: string) => number, all: () => [string, number][] }} o.epochs
 * @param {{ pending: () => { chatId?: string }[], rekey: (from: string, to: string) => void, discard: (nativeId: string) => Promise<void> }} o.target
 * @param {(problem: string) => void} o.report
 */
export function rekeyContinueState({ owners, epochs, target, report }) {
  /** @param {string} what @param {() => void} step */
  const attempt = (what, step) => {
    try {
      step();
    } catch (error) {
      report(`${what} was not moved to its Host id: ${/** @type {Error} */ (error).message}`);
    }
  };
  // the epoch first, as a continue's own activation writes it: the highest the chat reached under either spelling (a lower one is already behind)
  attempt('The epochs', () => {
    for (const [id, epoch] of epochs.all()) {
      const own = hostChatId(id);
      // one the chat has passed under the Host id (it moved on after the upgrade) is behind, not a problem
      if (own !== id && epochs.current(own) < epoch) attempt(`The epoch of ${id}`, () => epochs.admit(own, epoch));
    }
  });
  attempt('The owner records', () => {
    for (const [id, rec] of owners.entries()) {
      const own = hostChatId(id);
      if (own === id) continue;
      attempt(`The owner record of ${id}`, () => {
        const there = owners.get(own);
        // the record with the higher epoch (then the later one) is the chat's; the other is dropped with the handoff it kept
        const mine = !there || rec.epoch > there.epoch || (rec.epoch === there.epoch && rec.at > there.at);
        const winner = mine ? rec : there;
        const loser = mine ? there : rec;
        if (mine) owners.put(own, rec);
        // a crash between an owner write and its epoch (continue.mjs writes the record first) is healed here
        if (winner && winner.state !== 'prepared' && epochs.current(own) < winner.epoch) epochs.admit(own, winner.epoch);
        // a record already copied before a crash is the same preparation: its handoff is the winner's too
        if (loser?.state === 'prepared' && !(winner?.state === 'prepared' && winner.nativeId === loser.nativeId))
          void target.discard(loser.nativeId).catch((e) => report(`A replaced preparation did not close: ${e.message}`));
        owners.remove(id);
      });
    }
  });
  attempt('The waiting handoffs', () => {
    for (const { chatId } of target.pending()) {
      if (!chatId || hostChatId(chatId) === chatId) continue;
      attempt(`The waiting handoff of ${chatId}`, () => target.rekey(chatId, hostChatId(chatId)));
    }
  });
}
