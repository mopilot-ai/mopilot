// Claude Code CLIs started before a message needs them: a new chat's composer (prewarm) and an existing chat opened after its
// CLI ended (warm, #1830, Claude Desktop's onWarmUp). Until its chat sends, such a CLI says nothing to the windows.
const { transcriptTip } = require('./transcripts.cjs');

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ startSession: (key: string, opts: any) => Promise<any>, retire: (key: string) => Promise<unknown> }} sessions
 * @param {{ mayWarm: () => boolean }} governor
 */
function createWarm(state, sessions, governor) {
  /** Count `job` as the key's start, so a send on the key waits for it and uses its CLI. */
  function starting(key, job) {
    const entry = job.then(
      () => undefined,
      () => undefined,
    );
    state.starting.set(key, entry);
    void entry.then(() => state.starting.get(key) === entry && state.starting.delete(key));
  }

  /**
   * A CLI started before its chat's first message (electron/harness/claude/prewarm.cjs). Until `prewarmTaken`, it says
   * nothing to the windows. While it starts, it counts as starting, so a send on its key waits for it and uses it.
   */
  function prewarm(key, opts) {
    state.prewarmed.add(key);
    // the chat's first message is titled by the warm helper on its login, started with it (titleHelper.cjs)
    state.titleHelper?.warm(opts.account, opts.bin);
    const job = sessions.startSession(key, opts);
    starting(key, job);
    return job.then(
      () => undefined,
      (error) => {
        state.prewarmed.delete(key);
        throw error;
      },
    );
  }
  /** A prewarmed CLI's chat took it: from now on its end and errors are the chat's. */
  const prewarmTaken = (key) => state.prewarmed.delete(key);
  /** A prewarmed CLI no chat took ends (gracefully: its exit hooks run), and says nothing as it goes. */
  const prewarmDrop = (key) => sessions.retire(key).finally(() => state.prewarmed.delete(key));

  /**
   * Resume an existing chat's session in a CLI of its own before the chat sends (electron/harness/claude/warmOnOpen.cjs), with
   * the options its send would use, so the send finds it live. Nothing starts while its key has a CLI or a start, under
   * memory pressure or at the cap with no idle CLI to end. Until the chat sends (harness/claude/sessions.cjs send), the CLI is
   * silent and ends after WARM_IDLE_MS; its transcript's tip is taken now, so a write by another app meanwhile makes the
   * send resume afresh.
   * @returns {Promise<boolean>} whether a CLI started
   */
  async function warm(key, opts) {
    if (state.sessions.has(key) || state.starting.has(key) || !governor.mayWarm()) return false;
    const job = (async () => {
      // a CLI still running its exit hooks for this conversation quits before the next one resumes it
      if (state.retiring.has(key)) await state.retiring.get(key);
      state.prewarmed.add(key);
      const s = await sessions.startSession(key, opts);
      s.warmOnly = true;
      if (s.sessionId) s.tip = transcriptTip(s.sessionId);
      // never sent to: it ends silently, and the next CLI on the key (none started meanwhile) speaks
      void s.done.then(() => {
        if (s.warmOnly && !state.sessions.has(key) && !state.starting.has(key)) state.prewarmed.delete(key);
      });
      return s;
    })();
    starting(key, job);
    try {
      await job;
      return true;
    } catch (error) {
      state.prewarmed.delete(key);
      throw error;
    }
  }

  return { prewarm, prewarmTaken, prewarmDrop, warm };
}

module.exports = { createWarm };
