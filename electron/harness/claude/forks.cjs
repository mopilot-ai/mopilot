// The Claude sessions main forked for a window (claude:fork), and the one delete a window may ask for: a fork no chat took yet.
// Every other Claude delete is a whole chat's, through main's ChatDeletion (chats:delete), which retires its identity.

const { compactedHistory } = require('../../platform/claudeCompactedHistory.cjs');

/**
 * @param {{ sdk: () => Promise<any>, sessions: Map<string, unknown>, retiring: Map<string, unknown> }} state the Agent SDK,
 *   and the live and ending CLIs by key (`claude:<id>`)
 * @param {(messages: any, turnUuid: string) => string | null} forkPoint the message a fork from that turn ends at
 * @param {(sessionId: string) => Promise<unknown>} deleteSession ends the session's CLI, then deletes its transcript
 * @param {(sessionId: string) => Promise<string | null>} [findTranscript] where the session's transcript file is, so a turn
 *   from before a compaction can be forked from as well
 */
function createForks(state, forkPoint, deleteSession, findTranscript) {
  /** sessions forked in this process that no chat took yet (`claude:<id>`) */
  const unclaimed = new Set();
  /** (key) => whether a chat's record names the session: every one until main's chat store answers, so none is discarded */
  let chatNames = (_key) => true;
  /** Main's chat store (electron/platform/chats.cjs names) says which sessions a chat's record names. */
  const setChatNames = (fn) => void (chatNames = fn);

  /**
   * "Fork chat from here": up to the end of that turn (D-62); without one, the whole chat. Only a fork asked for as
   * `discardable` (one of several a switched chat's fork makes, forkSwitched.ts) may be discarded, until a chat takes it.
   */
  async function fork(sessionId, turnUuid, discardable) {
    const { forkSession, getSessionMessages } = await state.sdk();
    const read = turnUuid ? await getSessionMessages(sessionId) : [];
    // the SDK's list starts at the last compaction; the turns it folded away are still turns of the chat (compactedHistory)
    const folded = turnUuid && findTranscript ? await compactedHistory(await findTranscript(sessionId), read) : [];
    const upTo = turnUuid ? forkPoint([...folded, ...read], turnUuid) : null;
    const r = await forkSession(sessionId, upTo ? { upToMessageId: upTo } : undefined);
    if (discardable === true && typeof r?.sessionId === 'string' && r.sessionId) unclaimed.add(`claude:${r.sessionId}`);
    return r;
  }

  /** The session is a chat's now (a CLI ran it, a window named or opened it): it is deleted only with its chat. */
  const claim = (key) => void unclaimed.delete(key);

  /** Delete a fork a window made and could not finish (forkSwitched.ts); any other session is refused. */
  async function discard(sessionId) {
    const key = `claude:${sessionId}`;
    // taken off first: a second discard of the same fork, or one after it was taken, is refused
    if (typeof sessionId !== 'string' || !unclaimed.delete(key)) throw new Error('Only a fork no chat has taken can be discarded');
    if (state.sessions.has(key) || state.retiring.has(key) || chatNames(key))
      throw new Error('This fork belongs to a chat; delete the chat instead');
    return deleteSession(sessionId);
  }

  /** claude:fork, and claude:discardFork: a window deletes a chat only through chats:delete (ChatDeletion). */
  function register(ipcMain) {
    ipcMain.handle('claude:fork', (_e, sessionId, turnUuid, discardable) => fork(sessionId, turnUuid, discardable));
    ipcMain.handle('claude:discardFork', (_e, sessionId) => discard(sessionId));
  }

  return { fork, claim, discard, setChatNames, register };
}

module.exports = { createForks };
