// APNs routing across credential sets: a device token only works with its own app's topic, so with more than one iOS app the relay
// holds one set per app and finds the right one per token. The token's remembered set goes first, the others follow in config order.
// What one set's answer means for the next:
//   - sent                                   the send is done; the caller remembers this set for the token
//   - "this token is another app's" (400)    this set does not know the token: try the next set
//   - the set itself is unusable             its breaker is open or APNs refuses its credential (401, 403): it says nothing about the token,
//                                            so try the next set (a revoked key of one app must not stop the other app's pushes)
//   - anything else (410, a 5xx, a timeout, a payload refusal)
//                                            the send ends with this answer: a 410 is final, and after a transient failure the token may
//                                            still belong to this set, so it is neither pinned to another set nor removed
// A token is removed only when every set refused it as another app's; if any set could not answer, the result is a failure that keeps it.

/** A set that cannot answer for any token: its breaker is open, or APNs refused its credential. */
const setUnusable = (/** @type {import('./pushRetry.mjs').SendResult} */ r) =>
  r.breakerOpen === true || r.status === 401 || r.status === 403;

/**
 * @param {{ topic: string, send: (m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult> }[]} sets
 *   the guarded sender of each credential set, in the order they are tried
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>}
 *   the answer that ended the send, with the `topic` of the set that gave it when there are several (the caller remembers it after a success)
 */
export function apnsRouter(sets) {
  return async (m) => {
    // a hint that names no set (the operator changed the sets) is no hint
    const hinted = sets.find((set) => set.topic === m.topic);
    const order = hinted ? [hinted, ...sets.filter((set) => set !== hinted)] : sets;
    const tag = (/** @type {import('./pushRetry.mjs').SendResult} */ r, /** @type {{ topic: string }} */ set) =>
      sets.length > 1 ? { ...r, topic: set.topic } : r;
    let used = order[0];
    /** @type {import('./pushRetry.mjs').SendResult | undefined} the first answer of a set that could not answer */
    let unusable;
    let result = /** @type {import('./pushRetry.mjs').SendResult} */ ({ ok: false });
    for (const set of order) {
      used = set;
      result = await set.send(m);
      if (result.wrongApp) continue;
      if (!setUnusable(result)) return tag(result, set);
      unusable ??= result;
    }
    // no set took the token: if one could not even answer, the token may have been its own, so it is kept
    return tag(unusable ?? result, used);
  };
}
