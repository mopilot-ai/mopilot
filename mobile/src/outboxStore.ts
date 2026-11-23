// The phone's waiting messages kept on the device, sealed in the vault with the rest of its state: written one after another (the last state wins), read back once per start, and never overwritten before they were read.
import { restoreItems, savedItems, type QueuedSend } from './outbox';

type SavedOutbox = { user?: string; items?: unknown } | null;

export function createOutboxStore(o: {
  vault: () => { setOutbox(saved: { user: string; items: unknown[] } | null): Promise<unknown>; getOutbox(): Promise<SavedOutbox> };
  user: () => string | undefined;
  pairIds: () => string[];
  items: () => QueuedSend[];
  restore: (items: QueuedSend[]) => void;
  clear: () => void;
}) {
  /** Whether the messages saved before the app closed have been read back; nothing is written over them before that. */
  let restored = false;
  let saving: Promise<unknown> = Promise.resolve();
  /** The last write failed: the device still holds older messages than the app does, so the next connection and the next change write again. */
  let dirty = false;
  /** Keeps the waiting messages on the device, one write after another; the last state wins. */
  function persist(items: QueuedSend[]) {
    if (!restored) return;
    const user = o.user();
    const saved = items.length && user ? { user, items: savedItems(items) } : null;
    saving = saving.then(async () => {
      try {
        await o.vault().setOutbox(saved);
        dirty = false;
      } catch {
        dirty = true;
      }
    });
  }
  return {
    persist,
    dirty: () => dirty,
    /** An account with nothing to read back: what is typed from now on is kept. */
    markRestored() {
      restored = true;
    },
    /** Puts back what was typed before the app closed, for this account and the computers still paired; whatever cannot be read starts the queue empty. */
    async restore(userId: string) {
      let saved: SavedOutbox = null;
      try {
        saved = await o.vault().getOutbox();
      } catch {
        // a vault that cannot say starts the queue empty
      }
      // a connection made meanwhile does not matter here, but an account that left does; start() reaches this once per successful start
      restored = true;
      o.restore(
        saved?.user === userId && o.user() === userId ? restoreItems(saved.items, { now: Date.now(), pairs: new Set(o.pairIds()) }) : [],
      );
      // what was left out (a removed computer, another account's) goes from the device too
      if (saved) persist(o.items());
    },
    /** Sign-out and sign-in: nothing waiting stays, in memory or on the device, whatever the queue held. */
    forget() {
      o.clear();
      persist([]);
    },
  };
}
