// Whether a MoMo push comes from the newest home. The Host seals the lease of the home that sent it for this phone (`ss`, under the key of the Host enrollment) and the relay carries it unread, so the phone is the only fence: it opens the stamp, refuses one older than the newest seen for the account, and — once a stamped push has been seen for the account — treats a MoMo push whose stamp is missing, cannot be opened (another pair, another ref, garbage) or is stale as an old home's: it draws nothing and its tap opens no card. Pushes of other kinds are never touched.
import type { PushPayload } from '../push/payload';
import type { HomeCache, Stamp } from './homeCache';
import { openStamps } from './stamps';

/** What opens a sealed stamp: the account of this phone and a function that tries every Host enrollment's key on it. */
export type StampContext = { user: string; open: (sealed: string, ref: string) => Stamp | null };

/** The row that says a stamped push has been seen for the account (kept beside the account's newest stamp). */
export const pushRow = (user: string) => `${user}|push`;

export function createPushAdmit(d: {
  /** The account and keys of this phone; null when it has none (nobody signed in, no Host enrollment). */
  context: () => Promise<StampContext | null>;
  cache: () => Promise<Pick<HomeCache, 'newest' | 'keepStamp'>>;
  /** MoMo's home was ever used on this phone (a phone that never did keeps nothing and refuses nothing). */
  wasUsed: () => Promise<boolean>;
  /** Something was kept: the next launch checks the copy against the accounts and computers. */
  mark?: () => Promise<void>;
}) {
  let opened: ReturnType<typeof d.cache> | null = null;
  return async (payload: PushPayload): Promise<boolean> => {
    if (payload.kind !== 'momoNeedsYou') return true;
    try {
      if (!(await d.wasUsed())) return true;
      const ctx = await d.context();
      if (!ctx) return true;
      const cache = await (opened ??= d.cache());
      const stamp = payload.sealedStamp ? ctx.open(payload.sealedStamp, payload.ref) : null;
      if (!stamp) {
        // an unstamped push is believed only while no stamped one has been seen
        return (await cache.newest(pushRow(ctx.user))).status !== 'ok';
      }
      const admit = await openStamps(cache, ctx.user, d.mark);
      if (!admit.stamp(stamp)) return false;
      await cache.keepStamp(pushRow(ctx.user), stamp);
      await d.mark?.();
      return true;
    } catch {
      opened = null;
      // the check is a guard against a stale home, not a lock: a copy that cannot be opened refuses nothing
      return true;
    }
  };
}

/** A tap is delivered only when the push it came from is not an old home's: a stale push opens no card. */
export const guardTaps =
  (admit: (payload: PushPayload) => Promise<boolean>, onTap: (listener: (payload: PushPayload, reply?: string) => void) => () => void) =>
  (listener: (payload: PushPayload, reply?: string) => void) =>
    onTap((payload, reply) => void admit(payload).then((ok) => ok && listener(payload, reply)));
