// The one rule for which chat a native session (a Codex thread id, claude:<session id>) belongs to, from the chats' segments, shared by main's ChatController.chatOf and the window's chatOf.
// A session a switch started is a later segment of the chat that switched; a record of its own (a chat keyed by
// that native id, which a window or an earlier build could create) never takes it from that chat.

/**
 * Native session id -> chat id, from each chat's segments (as their native ids, in order). A later segment
 * (index > 0: a switch's session) answers over a chat's own first segment, so a stray record keyed by a switched
 * session's id can't capture its events, Stop, cards or tools.
 * @param {Iterable<[string, Iterable<string>]>} chats [chat id, the native ids of its segments in order]
 * @returns {Map<string, string>}
 */
export function segmentAliases(chats) {
  const own = new Map();
  const later = new Map();
  for (const [chatId, natives] of chats) {
    let i = 0;
    for (const nativeId of natives) (i++ === 0 ? own : later).set(nativeId, chatId);
  }
  for (const [nativeId, chatId] of later) own.set(nativeId, chatId);
  return own;
}

/**
 * The chat whose later segment (a switch's session) names `nativeId`, other than `chatId`, or null: such a native id
 * must never get a chat record of its own.
 * @param {Iterable<[string, Iterable<string>]>} chats
 * @param {string} nativeId
 * @returns {string | null}
 */
export function switchedOwner(chats, nativeId) {
  for (const [chatId, natives] of chats) {
    if (chatId === nativeId) continue;
    let i = 0;
    for (const id of natives) if (i++ > 0 && id === nativeId) return chatId;
  }
  return null;
}
