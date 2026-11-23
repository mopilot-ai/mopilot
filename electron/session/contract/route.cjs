// Who owns a chat's next message, read only from the segment record (kind), never from the shape of an
// id. An id's prefix is how a window names a native session ('claude:<id>', 'acp:<harness>:<id>');
// a kind this build doesn't know is an error, not a guess.
const { parseKind } = require('../../../shared/harnessKind.mjs');

/**
 * The family a segment kind belongs to: 'codex', 'claude' or 'acp:<harness>' (no session suffix).
 * @returns {import('../../../shared/harnessKind.mjs').HarnessFamily} throws for any other kind
 */
function familyOf(kind) {
  const parsed = parseKind(kind);
  if (!parsed || parsed.basic === '' || String(kind).split(':').length > 2)
    throw new Error(`Unknown harness kind: ${JSON.stringify(kind)}`);
  return parsed.family;
}

/**
 * A family's entry of a per-family table, for a segment kind; throws for a kind this build doesn't know. An entry
 * of `null` is the table's explicit "not on this harness", which the caller tells the user about.
 * @template T
 * @param {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, T>} table
 * @param {unknown} kind
 * @returns {T}
 */
const byFamily = (table, kind) => table[familyOf(kind)];

/** The native session a window-side key ('acp:kimi:s1') names, or null when it isn't an ACP key. */
function parseAcpKey(key) {
  const m = /^acp:([^:]+):(.+)$/s.exec(String(key));
  return m ? { harness: m[1], id: m[2] } : null;
}

/** A native event's family and session key must still name the chat's selected segment. */
function matchesSource(ref, source) {
  return familyOf(ref.kind) === source.kind && (source.key == null || ref.key === source.key);
}

module.exports = { familyOf, byFamily, parseAcpKey, matchesSource };
