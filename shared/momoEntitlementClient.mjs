// What a Mac or phone does to keep a Host's MoMo access backed by the server-signed entitlement (#5474): hold the token made for that Host, fetch a new one when it is missing or has under 18 hours left, and put it into the `host.momoGrant` it sends. One implementation for both clients; the fetch (the account service call) is theirs.
import { ENTITLEMENT_REFRESH_BELOW_MS } from './host/momoEntitlement.mjs';

/**
 * @param {object} o
 * @param {string} o.hostId the Host the token is for
 * @param {(hostId: string) => Promise<{ entitlement: string, expiresAt: number }>} o.fetchEntitlement reads an issued entitlement for this Host
 * @param {() => number} o.now
 * @param {{ get: () => { entitlement: string, expiresAt: number } | null, set: (v: { entitlement: string, expiresAt: number }) => void }} o.store where the held token is kept (per Host)
 */
export function createEntitlementClient({ hostId, fetchEntitlement, now, store }) {
  /** @type {Promise<{ entitlement: string, expiresAt: number }> | null} */
  let inflight = null;
  /** @param {boolean} force */
  const refresh = async (force) => {
    const held = store.get();
    if (!force && held && held.expiresAt - now() >= ENTITLEMENT_REFRESH_BELOW_MS) return held;
    // one call at a time: the 30-minute grant and a "Refresh access" click never fetch twice
    inflight ??= fetchEntitlement(hostId)
      .then((fresh) => {
        store.set(fresh);
        return fresh;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    /**
     * The `host.momoGrant` params. When the account service cannot be reached the token held goes (it may still be good for the Host, which judges it); with none held the grant goes without one and the Host says why.
     * @param {{ account: string, features: string[] }} grant
     * @param {{ force?: boolean }} [opts] `force`: the user pressed "Refresh access"
     * @returns {Promise<{ account: string, features: string[], entitlement?: string }>}
     */
    async grantParams(grant, { force = false } = {}) {
      try {
        const { entitlement } = await refresh(force);
        return { ...grant, entitlement };
      } catch {
        const held = store.get();
        return held ? { ...grant, entitlement: held.entitlement } : { ...grant };
      }
    },
  };
}
