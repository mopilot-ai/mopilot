// Locate the latest captured notification owned by one chat, independent of priority and arrival order.
export function latestChatNotification(notes: readonly { groupId: string }[], chatId: string): number {
  if (!chatId) return -1;
  return notes.findLastIndex((note) => note.groupId === chatId);
}
