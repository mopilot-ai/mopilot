// Claude Code's prewarm hook (electron/session/contract/prewarm.cjs, #1664). While a new chat's composer is open, this starts the
// CLI that chat's first send would start, under a session id the chat then takes. It uses the settings that send would
// work out (ClaudeAdapter.settings), so the send only writes the prompt. The CLI writes no transcript before its first
// message.
const crypto = require('node:crypto');

/** A chat with no pick of its own yet: the defaults and the login a new chat runs on. */
const NEW_CHAT = 'claude:new-chat';

/**
 * @param {object} o
 * @param {Pick<InstanceType<typeof import('./adapter.cjs').ClaudeAdapter>, 'settings' | 'live'>} o.adapter
 * @param {{ prewarm: (key: string, opts: object) => Promise<void>, prewarmTaken: (key: string) => unknown,
 *           prewarmDrop: (key: string) => Promise<unknown>, billingSig: () => string, nativeChromeFor: (account: string) => boolean,
 *           artifactsOf: (key: string | null) => { on: boolean }, isLive: (key: string) => boolean,
 *           gatewayDenials?: () => object[] }} o.api
 *   electron/harness/claude/index.cjs
 * @returns {import('../../session/contract/prewarm.cjs').PrewarmHook}
 */
function claudePrewarm({ adapter, api }) {
  const settingsNow = () => adapter.settings(NEW_CHAT, {});
  return {
    /** A CLI runs in its chat's folder on its login and billing, with its model, effort, permission and binary. */
    key(spec) {
      // a temporary chat writes nothing to disk and stays on the login it started on: it starts on send, as before
      if (typeof spec.cwd !== 'string' || !spec.cwd || spec.ephemeral) return null;
      const st = settingsNow();
      // (an absent value reads null in the key)
      // whether the CLI runs Claude in Chrome is fixed at its start, like its login (harness/claude/sessions.cjs nativeChrome)
      const chrome = api.nativeChromeFor(st.account);
      return JSON.stringify([
        spec.cwd,
        st.account,
        api.billingSig(),
        chrome,
        // and whether it has the Artifact tool (CLAUDE_CODE_ARTIFACT, electron/harness/claude/artifacts.cjs)
        api.artifactsOf(null).on,
        st.model,
        st.effort,
        st.permission,
        st.fast,
        st.prefs.claudeBin,
        // and the MCP gateway's servers it denies, fixed at its start (gatewayNative.cjs)
        api.gatewayDenials?.() ?? [],
      ]);
    },
    async warm(spec) {
      const id = crypto.randomUUID();
      const key = `claude:${id}`;
      const st = settingsNow();
      const want = { model: st.model, effort: st.effort, permission: st.permission, fast: st.fast, account: st.account };
      // what ClaudeAdapter.beginTurn and ChatController.claudeDeliver would hand send() for this chat's first message
      await api.prewarm(key, {
        bin: st.prefs.claudeBin,
        sessionId: id,
        resume: false,
        cwd: spec.cwd,
        forkFrom: undefined,
        ephemeral: false,
        ...want,
        basePermission: st.prefs.permission,
        chatId: key,
      });
      // a model, effort or permission picked before the send is applied to this CLI in place (liveControls)
      adapter.live.set(key, want);
      return { id, key };
    },
    // a CLI that quit meanwhile (a config change restarted it, it crashed) leaves the send to start one
    valid: (h) => api.isLive(h.key),
    claim(h) {
      api.prewarmTaken(h.key);
      return { id: h.id };
    },
    dispose(h) {
      adapter.live.delete(h.key);
      return api.prewarmDrop(h.key);
    },
  };
}

module.exports = { claudePrewarm, NEW_CHAT };
