// Who a connection is, for the audit line and the card's "answered on": from the connection's own standing (the third argument of a handler), never from a request.
import crypto from 'node:crypto';

/** The device behind a connection: an identifier that does not reveal its key, and the name it is shown by. @param {unknown} who */
export const deviceOf = (who) => {
  const p = /** @type {any} */ (who)?.principal?.();
  const id = p?.fingerprint
    ? `${p.kind}:${crypto.createHash('sha256').update(String(p.fingerprint)).digest('hex').slice(0, 12)}`
    : 'unknown';
  return { id, name: typeof p?.name === 'string' ? p.name : p?.kind };
};
