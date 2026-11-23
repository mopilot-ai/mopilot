// Sends remembered by request id while in flight or accepted, so a retry answers the same send and never sends twice; a failed or refused one is forgotten and sent again.

/**
 * @template T
 * @param {{ keep?: number, accepted?: (result: T) => boolean }} [o] keep: sends remembered for a retry (the oldest goes past it); accepted: whether a resolved result was taken (a refused receipt is not)
 * @returns {((key: string, dispatch: () => T | Promise<T>) => Promise<T>) & { sends: Map<string, Promise<T>> }}
 */
export function sendOnce({ keep = 256, accepted = () => true } = {}) {
  /** @type {Map<string, Promise<T>>} */
  const sends = new Map();
  const once = (/** @type {string} */ key, /** @type {() => T | Promise<T>} */ dispatch) => {
    const known = sends.get(key);
    if (known) return known;
    const sent = Promise.resolve().then(dispatch);
    sends.set(key, sent);
    if (sends.size > keep) sends.delete(/** @type {string} */ (sends.keys().next().value));
    const forget = () => sends.get(key) === sent && sends.delete(key);
    sent.then((result) => accepted(result) || forget(), forget);
    return sent;
  };
  return Object.assign(once, { sends });
}
