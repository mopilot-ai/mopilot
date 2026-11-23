// Type declarations for a temporary machine chat's identity and parent binding.
export const SIDE_CHAT_FEATURE: 'sideChats';
export const SIDE_CHAT_MARKER: 'side-chat-';
export const SIDE_CHAT_PARENT_CHANGED: 'side_chat_parent_changed';
export const SIDE_CHAT_PARENT_CHANGED_WORDS: string;
export function sideChatUuid(chatId: string): string | null;
export type SideChatStart = { sourceId: string; epoch: number };
