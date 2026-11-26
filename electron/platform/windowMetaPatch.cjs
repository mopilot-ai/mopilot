// A window's chat-meta patch as main applies it: without the keys only main writes, and with its config and notes changes
// merged onto the chat as main has it now, so what main wrote while the window's copy was older stays (#2520).
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/**
 * Meta keys only main writes: which chats are MoMo's, the routine (or the topic of a chat an older build made) a MoMo background chat runs for (electron/momo/mainChat.cjs
 * startBackground), the model and effort its brain names (#2304), how an input no human wrote is shown (electron/session/authoredInput.cjs),
 * a linked session's initial task title, and a confirmed native rewind's timestamp are never a window's to change.
 */
const MAIN_META_KEYS = [
  'momo',
  'routineId',
  'topicId',
  'momoModel',
  'momoEffort',
  'authored',
  'continueModel',
  'initialTitle',
  'rewoundAt',
];

/**
 * The chat's config with a window's `configKeys` ({ set, unset }, src/lib/chatMeta.ts chatChanges) applied, null once no
 * key is left; undefined when the change is malformed or names no key.
 */
function mergedConfig(current, change) {
  if (!isJsonRecord(change)) return undefined;
  const set = isJsonRecord(change.set) ? change.set : {};
  const unset = Array.isArray(change.unset) ? change.unset.filter((k) => typeof k === 'string') : [];
  if (!Object.keys(set).length && !unset.length) return undefined;
  const next = { ...(isJsonRecord(current) ? current : {}), ...set };
  for (const k of unset) delete next[k];
  return Object.keys(next).length ? next : null;
}

/** The chat's notes with the ones a window added (by id) after them; undefined when it added none main lacks. */
function mergedNotes(current, added) {
  if (!Array.isArray(added)) return undefined;
  const notes = Array.isArray(current) ? current : [];
  const ids = new Set(notes.map((n) => n?.id));
  const fresh = added.filter((n) => isJsonRecord(n) && typeof n.id === 'string' && !ids.has(n.id));
  return fresh.length ? [...notes, ...fresh] : undefined;
}

/**
 * A window's meta patch for a chat whose meta is `meta` now. A window never sends a whole config or notes list (it could
 * only hold a copy older than main's): one that does has those keys left out.
 */
function windowPatch(patch, meta) {
  if (!isJsonRecord(patch)) return null;
  const { config: _config, notes: _notes, configKeys, notesAdded, ...out } = patch;
  for (const k of MAIN_META_KEYS) delete out[k];
  const config = mergedConfig(meta?.config, configKeys);
  if (config !== undefined) out.config = config;
  const notes = mergedNotes(meta?.notes, notesAdded);
  if (notes) out.notes = notes;
  return out;
}

module.exports = { windowPatch, MAIN_META_KEYS };
