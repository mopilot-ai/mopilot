// The way the person last opened a MoMo draft on this phone (A3, momo/draftOpener.ts Pick): Gmail, the mail app or the share sheet, kept in the phone's own small store (the keychain, platform/draftPick.ts), never on the Mac or in MoMo. A store that fails or holds something else reads as no pick, and a failed write only means the person is asked again.
import { isPick, type Pick } from './draftOpener';

export type PickStore = { read(): Promise<string | null>; write(value: string | null): Promise<void> };

export function createDraftPick(store: PickStore) {
  return {
    /** The remembered pick, or null (none, unreadable or not a pick). */
    async get(): Promise<Pick | null> {
      try {
        const raw = await store.read();
        return isPick(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    /** Remembers `pick`; false when the store would not take it. */
    async set(pick: Pick): Promise<boolean> {
      return store.write(pick).then(
        () => true,
        () => false,
      );
    },
    /** Drops the pick (its way can no longer open). */
    async forget(): Promise<void> {
      await store.write(null).catch(() => undefined);
    },
  };
}
