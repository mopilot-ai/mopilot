// The notification permission flow: an in-app explanation always comes before the one-shot OS prompt, and a "not now" is not nagged.
export type OsPermission = 'granted' | 'denied' | 'undetermined';
export type PermissionStep = 'unknown' | 'granted' | 'explain' | 'later' | 'blocked';

export interface PermissionPort {
  status(): Promise<OsPermission>;
  /** The system prompt; only ever called after the explanation. */
  request(): Promise<'granted' | 'denied'>;
}
export interface DismissStore {
  read(): Promise<number | null>;
  write(at: number | null): Promise<void>;
}

export const REASK_MS = 7 * 24 * 60 * 60 * 1000;

export function createPermissionFlow(o: { port: PermissionPort; store: DismissStore; now?: () => number }) {
  const now = o.now ?? Date.now;
  // this run's "Not now", kept even when the store could not save it, so a slow or failing keychain never brings the card back
  let dismissedHere: number | null = null;
  return {
    /** Where the user stands: `explain` means show the explanation screen, `blocked` means only system settings can turn it on. */
    async step(): Promise<PermissionStep> {
      const os = await o.port.status();
      if (os === 'granted') return 'granted';
      if (os === 'denied') return 'blocked';
      const saved = await o.store.read();
      const dismissed = saved === null ? dismissedHere : dismissedHere === null ? saved : Math.max(saved, dismissedHere);
      return dismissed !== null && now() - dismissed < REASK_MS ? 'later' : 'explain';
    },
    /** The user accepted the explanation: ask the OS, and forget an earlier "not now". */
    async accept(): Promise<'granted' | 'denied'> {
      dismissedHere = null;
      const result = await o.port.request();
      await o.store.write(null);
      return result;
    },
    /** The user chose "Not now". */
    async dismiss() {
      dismissedHere = now();
      await o.store.write(dismissedHere);
    },
  };
}
