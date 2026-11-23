// The chat a raw harness event belongs to, as ChatController.onLiveEvent reports it.

/**
 * @param {'codex' | 'claude' | 'acp'} family
 * @param {any} e the event as the controller received it
 * @param {(key: string) => string} chatOf the chat a native session or thread belongs to
 * @returns {string | null}
 */
function liveChatOf(family, e, chatOf) {
  if (typeof e?.chatId === 'string') return e.chatId;
  if (family === 'codex') return typeof e?.params?.threadId === 'string' && e.params.threadId ? chatOf(e.params.threadId) : null;
  return typeof e?.key === 'string' && e.key ? chatOf(e.key) : null;
}

module.exports = { liveChatOf };
