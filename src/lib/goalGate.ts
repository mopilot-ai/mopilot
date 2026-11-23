// Why a chat can't take a goal, as the Goal entries (the "+" panel, the "/" menu, a typed /goal) show it.
// A temporary chat is never written to disk and neither harness keeps a goal for it (D-49).

export const TEMPORARY_GOAL = "Temporary chats can't have goals";

/**
 * The reason the Goal entries are greyed, or null when the chat can have a goal. `chat` is the open chat
 * (null on the new-chat screen, where `newChatTemporary` says whether the next chat will be temporary).
 */
export function goalOffReason(
  chat: { ephemeral?: boolean } | null | undefined,
  hasChat: boolean,
  newChatTemporary: boolean,
): string | null {
  return (hasChat ? !!chat?.ephemeral : newChatTemporary) ? TEMPORARY_GOAL : null;
}
