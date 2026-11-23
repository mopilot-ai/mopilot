// A Host that kept a message but did not start its turn (`queued` with the reason, as a Host before this change answered a refused start) has not taken it: every client reads that reply as a refused send, with the Host's reason. `queued` with no error is the message waiting behind a running turn, which the Host did take.

/**
 * The Host's reason when its reply to a `chat.send` or `chat.start` is a start it refused, else null. Reads the reply as the connection hands it over (`{ replayed, result }`) or the result alone.
 * @param {unknown} reply
 * @returns {string | null}
 */
export function startRefusal(reply) {
  const r = /** @type {any} */ (reply);
  const result = r && typeof r === 'object' && r.result && typeof r.result === 'object' ? r.result : r;
  return result?.action === 'queued' && typeof result.error === 'string' && result.error ? result.error : null;
}

/** Throws the refusal a reply carries, as the error a Host's own refusal is (`unsupported`: the same key may be sent again once the cause is gone; `fromHost`: it is the Host's own reason, as the queue reads it). @param {unknown} reply */
export function assertTaken(reply) {
  const why = startRefusal(reply);
  if (why !== null) throw Object.assign(new Error(why), { code: 'unsupported', fromHost: true });
}
