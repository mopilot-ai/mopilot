// Who may answer a chat's cards: a window that shows the chat, or a paired device that follows it; one rule for both so the two checks cannot diverge.

/** A window, by what its panes show (`shown(chatId)`, e.g. app/viewing.cjs shownBy). */
export const windowAnswerer = (shown) => ({ kind: 'window', has: (chatId) => !!shown(chatId) });

/** A paired device, by the chats it follows (anything with `has`). */
export const deviceAnswerer = (follows) => ({ kind: 'device', has: (chatId) => follows.has(chatId) });

/** Whether the surface shows or follows the chat, which is what authorizes it to answer that chat's cards. */
export const mayAnswer = (answerer, chatId) => typeof chatId === 'string' && answerer.has(chatId);

/** What a refused answerer is told. */
export const REFUSED = Object.freeze({
  window: 'Answer this question from its main chat.',
  device: 'Follow this chat to answer its cards.',
});
