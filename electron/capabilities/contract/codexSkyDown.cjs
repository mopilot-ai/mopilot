// A loaded native Codex thread whose Codex Computer Use (Sky) service didn't start: its native computer use is marked down, once, so its chat can say that new chats use MoPilot's computer use (#1381).
//
// The thread itself can't switch. A loaded thread's path is fixed until it unloads (codexConfig.cjs outgoing),
// and Codex keeps the tool list the thread loaded with: in the benchmark VM, showing desktop_* in the thread's
// sage-mcp session afterwards (session.cjs hide) did not reach the model, which still had no desktop tools on
// its next turn. New chats load with MoPilot's computer use while the service is down (nativeAvailability.cjs).

/**
 * Marks computer use down on `threadId`'s native path (its chat's thread for a sub-agent). Returns whether it was
 * up: the first report on a loaded native thread with native computer use.
 * @param {{ nativeThreads?: Map<string, { computer?: boolean }>, chatThreadOf: (threadId: string) => string, loaded: Set<string> } | null | undefined} tools
 *   the Codex tool injection (channels/codexConfig.cjs CodexToolInjection)
 * @param {string} threadId
 */
function computerDown(tools, threadId) {
  // no injection, or a stand-in without native threads (no sage-mcp): nothing to mark
  if (!tools?.nativeThreads || !threadId) return false;
  const id = tools.chatThreadOf(threadId);
  const surfaces = tools.nativeThreads.get(id);
  if (!surfaces?.computer || !tools.loaded.has(id)) return false;
  tools.nativeThreads.set(id, { ...surfaces, computer: false });
  return true;
}

module.exports = { computerDown };
