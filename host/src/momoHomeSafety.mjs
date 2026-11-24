// What this Host says it holds and the stand-down of an older home (home lane): the Host's own record read without a grant (it is the record, not MoMo's data), and the retirement of a running or moving home that a newer home at a higher epoch has superseded. The rules are pure (shared/host/momoHomeSafety.mjs).
import { HostRefusal } from './hostFs.mjs';
import { hostOwnStorageOf } from './momoHostOwn.mjs';
import { lookOf, standDownRule } from '../../shared/host/momoHomeSafety.mjs';

/**
 * @param {() => any} getHome the home these belong to (read when asked: it is made around them)
 * @param {{ now: () => number, storage: { dir: string, safeStorage: any } }} o
 */
export function createHomeSafety(getHome, { now, storage }) {
  return {
    /** The Host's own folder and key for one file a service may keep (by name; see ./momoHostOwn.mjs). */
    hostOwnStorage: hostOwnStorageOf(storage),
    /** What this Host holds, answered with no grant at all: a client without one learns "holds none" or "holds a home" and `grantLive`, never a veil. */
    look() {
      const home = getHome();
      return { version: 1, ...lookOf(home.record(), home.granted()) };
    },
    /**
     * Retire the home this Host holds when a newer one (another id at a higher epoch) exists: its services pause, its stores let go and its record is none with a tombstone naming the new home, so it is not "running" any more and a start cannot revive it. A Host at an equal or higher epoch, at the same home, or with no home changes nothing.
     * @param {{ homeId: string, leaseEpoch: number, name?: string }} lease
     */
    async standDown(lease) {
      const home = getHome();
      const before = home.record();
      if (!before) throw new HostRefusal('home_unavailable', "MoMo's home record on this machine cannot be read, so it was left as it is.");
      const first = standDownRule(before, lease, now(), home.newestEpoch());
      if ('raise' in first) {
        // the retired home takes the winner's real lease in a further step: its record only, nothing running changes
        await home.swap(before.leaseEpoch, (/** @type {any} */ r) => {
          const again = standDownRule(r, lease, now(), home.newestEpoch());
          if (!('raise' in again))
            throw new HostRefusal('home_lease_stale', 'MoMo moved on while this was being done.', { leaseEpoch: r.leaseEpoch });
          return again.raise;
        });
        return { stoodDown: true, leaseEpoch: first.raise };
      }
      if ('refused' in first)
        throw new HostRefusal(first.refused, 'That lease is further ahead than anything this machine has seen, so it was not trusted.');
      if (!('retire' in first)) return first;
      // the record first: when a move or a lease landed meanwhile the write refuses, and the services are still running as they were
      await home.swap(before.leaseEpoch, (/** @type {any} */ r) => {
        const again = standDownRule(r, lease, now(), home.newestEpoch());
        if (!('retire' in again))
          throw new HostRefusal('home_lease_stale', 'MoMo moved on while this was being done.', { leaseEpoch: r.leaseEpoch });
        const { leaseEpoch, ...fields } = again.retire;
        Object.assign(r, fields);
        // the winner's lease, as a move's tombstone keeps it: after a Reset clears the tombstone this machine never starts below it
        return leaseEpoch > r.leaseEpoch ? leaseEpoch : false;
      });
      await home.lifecycle('pause');
      await home.close();
      return { stoodDown: true, leaseEpoch: Math.max(before.leaseEpoch, lease.leaseEpoch) };
    },
  };
}
