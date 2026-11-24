// What a pairing run is stopped by and what a side may carry in a sealed body (R2b of #5576, split out of codePair.mjs, which re-exports both): the one error a run raises (its `code` is for the caller, never for a person) and the bounded plain object the two sides hand each other under the keys only they hold.

/** A run that must stop. `code` is for the caller, never for a person. */
export class CodePairError extends Error {
  /** @param {'bad_code' | 'bad_message' | 'bad_confirmation' | 'bad_body' | 'bad_proof' | 'unrecorded' | 'out_of_turn' | 'burned'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CodePairError';
    this.code = code;
  }
}

/** The most a carried object may be as JSON: the relay's box holds 2800 characters of base64url, and the message around it takes the rest. */
export const MAX_CARRY = 1200;

/**
 * What a side hands the other inside the sealed body (R2b: the controlling Mac's relay credential in m3, the controlled Host's half of the pair in m4): a plain object of bounded size, or nothing. It is sealed under keys only the two sides hold, and it is never read before the other side's proof of its key.
 * @param {unknown} v @returns {Record<string, unknown> | undefined}
 */
export function carryOf(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > MAX_CARRY)
    throw new CodePairError('bad_body', 'What was carried is not one object of a bounded size.');
  return /** @type {Record<string, unknown>} */ (v);
}
