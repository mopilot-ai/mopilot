// Which chat a MoPilot tool call comes from, on every harness: a tool session names its segment by the key the
// renderer gives it ('claude:<id>', 'acp:<harness>:<id>', a bare Codex thread id), and a chat owns the call only when
// it records that segment. Every owner check and every harness's tool session use these, so the two always agree.

/** The key a segment goes by in the renderer and in tool calls: '<kind>:<id>', except a Codex id, which is bare. */
const segmentKey = (/** @type {string} */ kind, /** @type {string} */ nativeId) => (kind === 'codex' ? nativeId : `${kind}:${nativeId}`);

/** A Codex thread id, which its segment key is bare: a UUID. */
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The harness a segment key names, the inverse of segmentKey: 'claude', 'acp:<harness>', 'codex' for a bare thread
 * id, or 'unknown' for anything else.
 * @param {string} key
 */
function harnessOfSegment(key) {
  const k = String(key ?? '');
  if (k.startsWith('claude:')) return 'claude';
  const acp = /^acp:([^:]+):/.exec(k);
  if (acp) return `acp:${acp[1]}`;
  return CODEX_ID.test(k) ? 'codex' : 'unknown';
}

/**
 * The chat a tool call's context belongs to, or null: `ctx.chatId` when that chat records the call's segment (with
 * `current`, only when it is the chat's current segment).
 * @param {Map<string, { segments: { kind: string, nativeId: string }[] }> | null | undefined} records the chats' records
 * @param {{ chatId: string, segmentId: string }} ctx
 * @param {{ current?: boolean }} [o]
 * @returns {string | null}
 */
function ownerOf(records, ctx, { current = false } = {}) {
  const segments = records?.get(ctx.chatId)?.segments ?? [];
  const mine = current ? segments.slice(-1) : segments;
  return mine.some((s) => segmentKey(s.kind, s.nativeId) === ctx.segmentId) ? ctx.chatId : null;
}

module.exports = { segmentKey, harnessOfSegment, ownerOf };
