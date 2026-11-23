// Temporary machine chat identities and the ownership snapshot their first message carries.
export const SIDE_CHAT_FEATURE = 'sideChats';
export const SIDE_CHAT_MARKER = 'side-chat-';
export const SIDE_CHAT_PARENT_CHANGED = 'side_chat_parent_changed';
export const SIDE_CHAT_PARENT_CHANGED_WORDS = 'The parent chat changed. Open a new side chat from it.';
const SIDE_ID = /^(?:(?:acp:[\w.-]+|claude):)?side-chat-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** The UUID of a side chat in either the app or the Host's spelling, or null for an ordinary chat. @param {string} chatId */
export const sideChatUuid = (chatId) => SIDE_ID.exec(chatId)?.[1] ?? null;

/** @typedef {{ sourceId: string, epoch: number }} SideChatStart */
