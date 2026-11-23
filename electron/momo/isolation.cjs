// How MoMo's chats are kept apart from the coding side on every harness (#2139, #2278): one rule, their MoMo tag, applied to Claude Code, Codex, the harness switch and ACP, by the app's main process and by a Host alike.

/**
 * MoMo's chats run apart from the coding side on every harness, by one rule (their MoMo tag): no harness memory or user
 * instructions, and none of the harness's own file and shell tools (Codex's thread config and memory switch, a harness
 * switch's new thread, Claude Code's session options, an ACP chat's confined process, permission requests and file and
 * terminal requests: acp/isolation.cjs).
 * @param {any} live main's sessions (codex, switchRunner, acpHost, controller)
 * @param {{ setIsolated: (fn: (chatId: string) => boolean) => void }} claude electron/harness/claude/index.cjs
 * @param {(chatId: string) => boolean} isMomoChat
 * @param {string | null} [workspace] MoMo's workspace folder: where a harness switch starts a MoMo chat's new session
 */
function isolateMomoChats(live, claude, isMomoChat, workspace = null) {
  claude.setIsolated(isMomoChat);
  live.codex?.setIsolated(isMomoChat);
  if (live.switchRunner) {
    live.switchRunner.isolated = isMomoChat;
    live.switchRunner.workspaceOf = (/** @type {string} */ chatId) => (workspace && isMomoChat(chatId) ? workspace : null);
  }
  // an ACP request names its session's key, which a chat that switched harnesses doesn't share
  if (live.acpHost) live.acpHost.isolated = (/** @type {string} */ key) => isMomoChat(live.controller?.chatOf(key) ?? key);
}

module.exports = { isolateMomoChats };
