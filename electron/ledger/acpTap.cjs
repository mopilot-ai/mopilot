// The request ledger's ACP tap: the ACP host's events become ledger records. ACP reports no finer grain than a
// session/prompt, so each prompt is one line: its stop reason or error, the usage the agent answered with (when it
// sends any) and the session's current model (models.currentModelId, or a select config option of category 'model').
// A provider failure the harness retries in silence (its stderr, electron/harness/acp/providerErrors.cjs) is a `retry`
// line of its own, as Codex's willRetry errors and Claude Code's api_retry are (#1534).

/**
 * @typedef {import('./line.cjs').LedgerRecord} LedgerRecord
 * @typedef {{ session?: string, model?: string, turn?: string }} AcpSession
 */

const parseKey = (key) => /^acp:([^:]+):(.+)$/.exec(String(key ?? ''));

/** The model a session state names, if it names one. */
function modelOf(state) {
  const opt = (Array.isArray(state?.configOptions) ? state.configOptions : []).find((o) => o?.category === 'model');
  if (typeof opt?.currentValue === 'string') return opt.currentValue;
  const id = state?.models?.currentModelId;
  return typeof id === 'string' ? id : undefined;
}

class AcpLedgerTap {
  /**
   * @param {object} o
   * @param {(r: LedgerRecord) => unknown} o.record
   * @param {(key: string) => string} o.chatOf the MoPilot chat a session key belongs to
   */
  constructor(o) {
    this.recordFn = o.record;
    this.chatOf = o.chatOf;
    /** @type {Map<string, AcpSession>} by key */
    this.sessions = new Map();
  }

  /** An event of the ACP host (electron/harness/acp.cjs). */
  event(e) {
    const k = parseKey(e?.key);
    if (!k) return;
    const s = this.sessions.get(e.key) ?? {};
    this.sessions.set(e.key, s);
    if (e.kind === 'session' || e.kind === 'state') {
      if (typeof e.sessionId === 'string') s.session = e.sessionId;
      s.model = modelOf(e.state ?? e) ?? s.model;
    } else if (e.kind === 'providerError') {
      const base = { harness: k[1], chat: this.chatOf(e.key), session: s.session ?? k[2], turn: e.turnId, account: { id: k[1] } };
      this.recordFn({ ...base, req: s.model, outcome: 'retry', code: 'provider_error', error: e.error });
    } else if (e.kind === 'turnEnd') {
      const u = e.usage ?? {};
      const outcome = e.stopReason === 'cancelled' ? 'interrupted' : e.error ? 'error' : 'ok';
      this.recordFn({
        harness: k[1],
        chat: this.chatOf(e.key),
        session: s.session ?? k[2],
        turn: e.turnId,
        // ACP harnesses have one sign-in each, named by the harness (electron/identity/drivers/acp.cjs)
        account: { id: k[1] },
        // an ACP agent bills through its own sign-in, which MoPilot cannot see
        pay: 'unknown',
        req: s.model,
        outcome,
        code: outcome === 'ok' ? undefined : e.stopReason,
        error: e.error ?? undefined,
        in: u.inputTokens,
        out: u.outputTokens,
        cacheRead: u.cachedReadTokens,
        cacheWrite: u.cachedWriteTokens,
        reasoning: u.thoughtTokens,
      });
    } else if (e.kind === 'closed') {
      this.sessions.delete(e.key);
    }
  }
}

module.exports = { AcpLedgerTap, modelOf };
