// A device's outbox for MoMo (design 1, W1.7): a message is saved on the device with its own id before it is sent, goes out only when the home can take it, and is never sent again after a doubtful delivery: a message written while the home sleeps was never sent, so it is safe to send when the home is back; one that was sent and not confirmed is only ever asked about (`host.momoTurn`). Pure over an injected store, so the Mac (a file) and the phone (its storage) keep the same rules.

/** @typedef {{ turnId: string, chatId: string, text: string, createdAt: number, delivery: 'not-sent' | 'sent-uncertain' }} OutboxEntry */
/** @typedef {{ read: () => OutboxEntry[], write: (entries: OutboxEntry[]) => void }} OutboxStore */

/** The oldest message never sent an outbox keeps: older than a day, it is dropped rather than sent late. */
export const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;

/** @param {{ store: OutboxStore, now: () => number }} o */
export function createMomoOutbox({ store, now }) {
  /** @param {(all: OutboxEntry[]) => OutboxEntry[]} change */
  const update = (change) => store.write(change(store.read()));
  return {
    /** Save a message before sending it: its id is the key the send will carry. @param {{ turnId: string, chatId: string, text: string }} m */
    save({ turnId, chatId, text }) {
      update((all) =>
        all.some((e) => e.turnId === turnId) ? all : [...all, { turnId, chatId, text, createdAt: now(), delivery: 'not-sent' }],
      );
    },
    /** Called just before the send goes out: from here the device cannot know whether it arrived. @param {string} turnId */
    sending(turnId) {
      update((all) => all.map((e) => (e.turnId === turnId ? { ...e, delivery: 'sent-uncertain' } : e)));
    },
    /** The home has it (accepted, or any later state), or the person gave it up: it leaves the outbox. @param {string} turnId */
    settle(turnId) {
      update((all) => all.filter((e) => e.turnId !== turnId));
    },
    /**
     * The home said it has not accepted this turn (yet): it goes out again under the SAME id, once the person agrees. The home accepts one
     * copy and answers the other as a duplicate, so the original, if it is still on its way, can never run as well. @param {string} turnId
     */
    neverArrived(turnId) {
      update((all) => all.map((e) => (e.turnId === turnId ? { ...e, delivery: 'not-sent' } : e)));
    },
    /**
     * What may go out now, oldest first: only messages never sent, at most one per chat (the home takes one open turn per chat). A message
     * never sent that is older than a day is dropped (the person is not surprised by a day-old text); one sent and not confirmed is never
     * dropped: it stays on the screen as "not sure" until the person decides.
     */
    due() {
      const all = store.read();
      const fresh = all.filter((e) => e.delivery === 'sent-uncertain' || now() - e.createdAt <= OUTBOX_MAX_AGE_MS);
      if (fresh.length !== all.length) store.write(fresh);
      const busy = new Set(fresh.filter((e) => e.delivery === 'sent-uncertain').map((e) => e.chatId));
      /** @type {OutboxEntry[]} */
      const out = [];
      for (const e of [...fresh].sort((a, b) => a.createdAt - b.createdAt)) {
        if (e.delivery !== 'not-sent' || busy.has(e.chatId)) continue;
        busy.add(e.chatId);
        out.push(e);
      }
      return out;
    },
    /** Everything the chat shows as waiting or in doubt. */
    all: () => store.read(),
  };
}
