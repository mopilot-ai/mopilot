// Share the existing Claude retirement-and-delete operation between native IPC and whole-chat deletion.
function createDeleteSession(state, cliSessions, unrefTimer) {
  return async (sessionId) => {
    // Archive may already have removed the live entry while its CLI is still exiting.
    // Join that retirement before capturing a session that became live during the wait.
    await state.retiring.get(`claude:${sessionId}`);
    // A live CLI writes its transcript as it exits; retire it before deleting the transcript.
    const s = state.sessions.get(`claude:${sessionId}`);
    // a deleted chat leaves no Remote Control link up or remembered
    await cliSessions.remote?.release(sessionId, s);
    await cliSessions.retire(`claude:${sessionId}`);
    if (s) await Promise.race([s.done, new Promise((r) => unrefTimer(r, 5000))]);
    const deleted = await (await state.sdk()).deleteSession(sessionId);
    state.endedTips.delete(sessionId);
    return deleted;
  };
}
module.exports = { createDeleteSession };
