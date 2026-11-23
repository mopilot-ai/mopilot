// Whether a paired phone's read of a chat is MoMo's (its replies carry answer chips, shared/momoOptions.mjs): MoMo is on for the account (main made its services) and the chat's record is MoMo's; any other chat, and every chat while MoMo is off, is read as it is.
const { isMomoMeta } = require('../../shared/momoChat.mjs');

/** @param {any} live main's late-bound services @param {string} chatId */
const isPhoneMomoChat = (live, chatId) => !!live.momo && isMomoMeta(live.chats?.records.get(chatId)?.meta);

module.exports = { isPhoneMomoChat };
