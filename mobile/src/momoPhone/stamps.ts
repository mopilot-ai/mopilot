// The phone refuses what an old home says: every view, event, card and push of MoMo's home carries the lease stamp of the home that sent it, and anything older than the newest lease seen for this account (kept sealed on the phone, so it survives a restart) is dropped, so a machine that still believes it is the home after the owner reclaimed it at a higher epoch is never believed.
import { createStampSink } from '../../../shared/momoStamp.mjs';
import type { HomeCache, Stamp } from './homeCache';
import type { PhoneView } from './types';

export type Admit = {
  /** A view or event of the home: its own stamp, or none yet (a phone that has seen no lease takes the first home that has none). */
  view(v: PhoneView): boolean;
  /** A stamp opened from a push: current or newer is taken (and kept), an old one or a second machine at the same lease is refused. */
  stamp(stamp: Stamp): boolean;
};

/** The stamp a view carries: the home that holds the lease and its epoch, or null before there is one. */
export const stampOf = (v: PhoneView): Stamp | null => {
  const { homeMachineId, leaseEpoch } = v.view.home;
  return homeMachineId && leaseEpoch ? { homeId: homeMachineId, leaseEpoch } : null;
};

/**
 * The admission for one account. The newest stamp is read from the sealed copy first; one that cannot be read starts from none (the check is a guard
 * against a stale home, not a lock: it must never keep the person out of their own home). A newer stamp is kept sealed as soon as it is seen.
 */
export async function openStamps(
  cache: Pick<HomeCache, 'newest' | 'keepStamp'> | null,
  user: string,
  kept: () => Promise<void> = async () => undefined,
): Promise<Admit> {
  const read = cache ? await cache.newest(user).catch(() => null) : null;
  let newest: Stamp | null = read?.status === 'ok' ? read.stamp : null;
  const sink = createStampSink({
    read: () => newest,
    write: (stamp: Stamp) => {
      newest = stamp;
      void cache
        ?.keepStamp(user, stamp)
        .then(kept)
        .catch(() => undefined);
    },
  });
  return {
    view(v) {
      const stamp = stampOf(v);
      return stamp ? sink.accept(stamp).ok : sink.newest() === null;
    },
    stamp: (stamp) => sink.accept(stamp).ok,
  };
}
