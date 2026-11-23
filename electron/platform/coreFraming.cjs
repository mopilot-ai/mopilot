// Newline framing by the Rust core (core/crates/framing): the complete lines it hands back, read out of its layout, and a
// framer for a stream the core doesn't own (a socket, a child Node started), through the framing routes. A harness child's
// stdout is framed on the core's own reader thread instead (electron/platform/coreChild.cjs `lines`).
const { constants } = require('node:buffer');
const { core, requiredCore } = require('./core.cjs');

/**
 * The longest line a stream with no limit of its own takes, in UTF-16 units: the longest string JS can hold, which is what
 * decoding one ever allowed. It bounds what a line that never ends costs.
 */
const MOST_UNITS = constants.MAX_STRING_LENGTH;

/** What a line past its limit fails with, as the transport has always said it. */
const TOO_LONG = 'JSON message exceeds the transport size limit';
/** The length the core puts in place of a line past the limit: eight bytes of 0xff (framing's `TOO_LONG`). */
const TOO_LONG_HIGH = 0xffffffff;

/**
 * The lines the core framed, in order, each a view of `framed` without its newline; whether a line past the limit ended them.
 * @param {Buffer} framed eight bytes of length, little-endian, then the line, for each line
 * @returns {{ lines: Buffer[], tooLong: boolean }}
 */
function framedLines(framed) {
  /** @type {Buffer[]} */
  const lines = [];
  for (let at = 0; at < framed.length; ) {
    const high = framed.readUInt32LE(at + 4);
    if (high === TOO_LONG_HIGH) return { lines, tooLong: true };
    const end = at + 8 + framed.readUInt32LE(at) + high * 2 ** 32;
    lines.push(framed.subarray(at + 8, end));
    at = end;
  }
  return { lines, tooLong: false };
}

/**
 * A framer the core holds for one stream: `push` its bytes as they come, for the complete lines they end; `close` when it
 * is done. Throws when there is no core to frame with: there is no other.
 * @param {number} [maxUnits] the longest line, in UTF-16 units; one that is not finite is `MOST_UNITS`
 * @param {import('./core.cjs').CoreAddon | null} [addon]
 */
function openFramer(maxUnits = MOST_UNITS, addon = core()) {
  const dispatch = requiredCore(addon).dispatchSync;
  const id = String(dispatch('framing.open', Buffer.from(String(Number.isFinite(maxUnits) ? maxUnits : MOST_UNITS))));
  const prefix = Buffer.from(`${id}\n`);
  let open = true;
  return {
    /** @param {Buffer} bytes */
    push: (bytes) => framedLines(dispatch('framing.push', Buffer.concat([prefix, bytes]))),
    close() {
      if (open) dispatch('framing.close', Buffer.from(id));
      open = false;
    },
  };
}

module.exports = { MOST_UNITS, TOO_LONG, framedLines, openFramer };
