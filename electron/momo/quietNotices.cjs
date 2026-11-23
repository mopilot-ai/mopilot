// MoMo's chats make no system banner (#2139): a routine's result, a run waiting for the user, a goal or a sign-in a MoMo chat needs show in MoMo's own chat and its one "MoMo needs you" notice (notices.cjs), never as an app notification naming a MoMo chat on the coding side. The filter sits in the app's one Notifier (setQuiet), so every caller is covered: the ChatController's turn and approval notices, a cross-chat message's turn notice (MoMo chats can't be messaged, #2168, but a delivered one stays quiet too), the controller's question notices, goal and usage-limit notices, and computer use's auth notice.
// Not filtered: 'scheduled' (MoMo's runs make none: schedulerTasks.cjs keeps them out, and MoMo never sets on_approval
// skip) and 'computer' (keyed to a paired device, not to a chat).

/** The chat-keyed notice kinds a MoMo chat keeps to MoMo. */
const MOMO_QUIET = new Set(['turn', 'approval', 'goal', 'auth']);

/**
 * The Notifier's quiet predicate (Notifier.setQuiet) for MoMo's chats. `isMomoChat` is read at every notice; the
 * integration passes MoMo's chat check (isMomoMeta on the chat's meta, #2161).
 * @param {(chatId: string) => boolean} isMomoChat
 * @returns {(kind: string, chatId: string) => boolean}
 */
function momoQuiet(isMomoChat) {
  return (kind, chatId) => MOMO_QUIET.has(kind) && isMomoChat(chatId) === true;
}

module.exports = { momoQuiet, MOMO_QUIET };
