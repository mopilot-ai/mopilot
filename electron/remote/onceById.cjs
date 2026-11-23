// Runs one action once per client-chosen id: a retry (a phone resending after a lost reply) gets the same result, the same id for something else is refused.
const { RemoteError } = require('./serviceErrors.cjs');

/** How many ids per service are remembered to answer a retry. */
const REMEMBERED = 1000;

/**
 * @param {string} refusal what a client is told when it reuses an id for a different request
 * @returns {(svc: object, key: string, print: string, make: () => Promise<any>) => Promise<any>}
 */
function createOnce(refusal) {
  /** service -> id key -> what that request asked and what came of it. */
  const STORES = new WeakMap();
  return (svc, key, print, make) => {
    let seen = STORES.get(svc);
    if (!seen) STORES.set(svc, (seen = new Map()));
    const earlier = seen.get(key);
    if (earlier) {
      if (earlier.print !== print) throw new RemoteError('stale', refusal);
      return earlier.result;
    }
    const result = make();
    seen.set(key, { print, result });
    // a request that failed may be tried again under the same id
    result.catch(() => seen.get(key)?.result === result && seen.delete(key));
    while (seen.size > REMEMBERED) seen.delete(seen.keys().next().value);
    return result;
  };
}

module.exports = { createOnce, REMEMBERED };
