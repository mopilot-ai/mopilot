// The version gate of the Host protocol, free of everything else so the phone can import it (the rest of schema.mjs reads method files from disk): this build's protocol, the refusal, and what two ends can speak after `host.hello`.

/** This build's protocol: `minor` grows with additive changes; a peer whose minor is below `floor` is refused. */
export const PROTOCOL = Object.freeze({ minor: 1, floor: 1 });
/** A request the two ends cannot serve safely: `code` says why and the message is safe to show. */
export class GateError extends Error {
  /** @param {'version_refused' | 'feature_missing'} code @param {string} message @param {string[]} [missing] */
  constructor(code, message, missing = []) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.missing = missing;
  }
}
/**
 * What two ends can speak after `host.hello`: the lower minor, and the features both declare. Throws a GateError when
 * either end's floor is above the other's minor.
 * @param {{ protocol: { minor: number, floor: number }, features: string[] }} mine
 * @param {{ protocol: { minor: number, floor: number }, features: string[] }} theirs
 */
export function negotiate(mine, theirs) {
  if (theirs.protocol.minor < mine.protocol.floor || mine.protocol.minor < theirs.protocol.floor)
    throw new GateError('version_refused', 'This app and the host speak versions too far apart. Update the older one.');
  const both = new Set(theirs.features);
  return { minor: Math.min(mine.protocol.minor, theirs.protocol.minor), features: mine.features.filter((f) => both.has(f)) };
}
