// Claude Code's warm on open (#1830, electron/session/warmOnOpen.cjs): an existing chat whose CLI ended gets one resuming its
// session, started with the options its next send would use (ClaudeAdapter.beginTurn), so the send finds it live.

/**
 * @param {object} o
 * @param {any} o.adapter the ClaudeAdapter: settings(), sessions, live, startingTurns
 * @param {{ isLive: (key: string) => boolean, sessionCwd: (id: string) => Promise<string | null | undefined>, warm: (key: string, opts: any) => Promise<boolean> }} o.api
 * @param {(chatId: string) => { key: string, id: string } | null | undefined} o.ref the chat's current segment
 */
function claudeWarmOnOpen({ adapter, api, ref }) {
  return {
    /** `current`: whether the chat is still worth warming (in view, the app not quitting). @returns {Promise<boolean>} whether a CLI started */
    async warm(/** @type {string} */ chatId, current = () => true) {
      const r = ref(chatId);
      if (!r?.key || !r.id) return false;
      const key = r.key;
      if (api.isLive(key) || adapter.startingTurns?.has(key)) return false;
      const sess = adapter.sessions.get(key) ?? {};
      // a chat with nothing on disk yet (its first send starts it, or the composer's prewarm did), a side chat, a temporary one
      if (sess.fresh || sess.forkFrom || sess.ephemeral) return false;
      const cwd = sess.cwd || (await api.sessionCwd(r.id));
      // the chat left, or the app began quitting, while its folder was read
      if (!cwd || !current()) return false;
      const st = adapter.settings(chatId, {});
      const want = { model: st.model, effort: st.effort, permission: st.permission, fast: st.fast, account: st.account };
      const opts = { bin: st.prefs.claudeBin, sessionId: r.id, resume: true, cwd, ...want, basePermission: st.prefs.permission, chatId };
      const started = await api.warm(key, opts);
      // a pick made before the send applies to this CLI in place (liveControls), as to any live one
      if (started) adapter.live.set(key, want);
      return started;
    },
  };
}

module.exports = { claudeWarmOnOpen };
