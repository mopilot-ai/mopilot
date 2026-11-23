// Bookmarked messages per chat for turn navigation: toggling one without touching other chats.

/** Immutable per-chat updates retain bookmarks belonging to other chats. */
export function toggleMessageBookmark(bookmarks: Record<string, string[]>, chatId: string, messageId: string): Record<string, string[]> {
  const entries = bookmarks[chatId] ?? [];
  const next = entries.includes(messageId) ? entries.filter((id) => id !== messageId) : [...entries, messageId];
  const map = { ...bookmarks };
  if (next.length) map[chatId] = next;
  else delete map[chatId];
  return map;
}
