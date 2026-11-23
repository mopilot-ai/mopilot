// What receives a stamped action or push of MoMo's home (a client, the relay's sender, another Host) refuses a stamp older than the newest lease it has seen (home lane S1, design 3.1): `home.current(stamp)` only knows the Host it runs on, so after a move the old home's late push or answer would be believed by anything that did not remember the new epoch. One sink per receiver, over its own small store.

/** @typedef {{ homeId: string, leaseEpoch: number }} Stamp */
/** @typedef {{ read: () => { homeId: string, leaseEpoch: number } | null, write: (newest: { homeId: string, leaseEpoch: number }) => void }} StampStore */

/** Whether `v` is a stamp. @param {unknown} v @returns {v is Stamp} */
const isStamp = (v) =>
  !!v &&
  typeof v === 'object' &&
  typeof (/** @type {any} */ (v).homeId) === 'string' &&
  !!(/** @type {any} */ (v).homeId) &&
  Number.isSafeInteger(/** @type {any} */ (v).leaseEpoch) &&
  /** @type {any} */ (v).leaseEpoch > 0;

/** @param {StampStore} store */
export function createStampSink(store) {
  return {
    /**
     * Take a stamp: it is good when it is the newest lease seen or a newer one (which it remembers), refused when it is older, or at the same lease
     * from another machine (two claimants of one lease: neither is trusted). Anything that is not a stamp is refused.
     * @param {unknown} stamp
     * @returns {{ ok: true } | { ok: false, reason: 'not-a-stamp' | 'stale' | 'two-homes', newest: Stamp | null }}
     */
    accept(stamp) {
      const newest = store.read();
      if (!isStamp(stamp)) return { ok: false, reason: 'not-a-stamp', newest };
      if (newest && stamp.leaseEpoch < newest.leaseEpoch) return { ok: false, reason: 'stale', newest };
      if (newest && stamp.leaseEpoch === newest.leaseEpoch && stamp.homeId !== newest.homeId)
        return { ok: false, reason: 'two-homes', newest };
      if (!newest || stamp.leaseEpoch > newest.leaseEpoch) store.write({ homeId: stamp.homeId, leaseEpoch: stamp.leaseEpoch });
      return { ok: true };
    },
    /** The newest lease seen, null before any. */
    newest: () => store.read(),
  };
}
