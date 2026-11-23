// Which Codex thread's turn a call on a thread's sage-mcp session is kept for (the Registry's turnThread rule).
const { codexCallThread } = require('./codexThreadContracts.cjs');

/**
 * The thread the call came from, as its turn metadata names it (codexCallThread), when that is the session's thread
 * or the chat's own sub-agent (`named`). A sub-agent that shares its parent's session thus has its calls on its own
 * turn. Otherwise (no metadata, metadata that doesn't say whose call it is, another chat's thread, or a thread the
 * chat has not linked, whose turn's end could not be placed) the call rides on the session's thread, unnamed, and
 * that thread's turn ends by the spawn-group rule (turnEnd.cjs threadTurns). Null for a session that is not a Codex
 * thread's (ACP): the chat's one turn.
 * @param {{ hasThread: (id: string) => boolean, isLoadedThread: (id: string) => boolean, ownerOf: (id: string) => string }} threads
 *   the Codex tool injection (codexConfig.cjs)
 * @param {string} chatId the chat the session's calls are charged to
 * @param {string} segmentId the session's thread
 * @param {unknown} meta the call's params._meta (null without one)
 * @param {(error: unknown) => void} ignored where a failed owner lookup is noted (the call then rides on the session)
 * @returns {{ thread: string, named: boolean } | null}
 */
function turnThreadOf(threads, chatId, segmentId, meta, ignored) {
  if (!threads.hasThread(segmentId) && !threads.isLoadedThread(segmentId)) return null;
  const { thread, named } = codexCallThread(meta);
  if (!thread || !named) return { thread: segmentId, named: false };
  if (thread === segmentId) return { thread, named: true };
  /** @type {string | null} */
  let owner = null;
  try {
    owner = threads.ownerOf(thread);
  } catch (error) {
    ignored(error);
  }
  return owner === chatId ? { thread, named: true } : { thread: segmentId, named: false };
}

module.exports = { turnThreadOf };
