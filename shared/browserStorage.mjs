// Where the built-in browser keeps a chat's cookies, storage and cache (IAB-08), shared by the pane
// (which names a tab's partition) and main (which checks it and clears it when the chat ends).
//
// - 'shared' (the default): every chat uses one persistent profile, so sign-ins carry over.
// - 'session': each chat gets its own in-memory partition, private to that chat and cleared when the
//   chat ends (archived) or the app quits.

/** The persistent profile every chat shares. */
export const SHARED_PARTITION = 'persist:browser';
const CHAT_PREFIX = 'mopilot-chat-';
const CHAT_PARTITION = /^mopilot-chat-[A-Za-z0-9_-]{1,80}-[0-9a-f]{8}$/;

/** A short, stable hash of a chat id (FNV-1a), so ids that sanitize alike still get their own partition. */
function idHash(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The storage mode a preference names; anything else is 'shared'. */
export function storageMode(value) {
  return value === 'session' ? 'session' : 'shared';
}

/**
 * The partition a chat's browser tabs use: the shared persistent profile, or with storage 'session' an
 * in-memory partition for that chat alone (no "persist:" prefix). A tab of no chat always shares.
 */
export function browserPartition(storage, chatId) {
  if (storageMode(storage) !== 'session' || typeof chatId !== 'string' || !chatId) return SHARED_PARTITION;
  return `${CHAT_PREFIX}${chatId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${idHash(chatId)}`;
}

/** Whether a partition name is a chat's own in-memory partition (as browserPartition makes them). */
export function isChatPartition(value) {
  return typeof value === 'string' && CHAT_PARTITION.test(value);
}
