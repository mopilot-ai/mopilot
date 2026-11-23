// The request ledger's Codex tap: the app-server's turn, token-usage, reroute and error notifications (as the adapter's
// observe sees them, raw) and the adapter's turnStarted (the model and effort it asked for) become ledger records.
// One `thread/tokenUsage/updated` is one sampling request: its `last` breakdown is that request's tokens.

/**
 * @typedef {import('./line.cjs').LedgerRecord} LedgerRecord
 * @typedef {import('./line.cjs').LedgerAccount} LedgerAccount
 * @typedef {{ thread: string, chat?: string, account?: LedgerAccount | null, req?: string, effort?: string,
 *   served?: string, errored?: boolean, total?: number }} CodexTurn
 */

/** The HTTP status a codexErrorInfo carries (`{ responseStreamConnectionFailed: { httpStatusCode } }`), if any. */
function statusOf(info) {
  if (!info || typeof info !== 'object') return undefined;
  for (const v of Object.values(info)) if (typeof v?.httpStatusCode === 'number') return v.httpStatusCode;
  return undefined;
}

/**
 * A TurnError's HTTP status: its codexErrorInfo's, else the one its text names (the upstream's JSON error envelope,
 * `"status":429`, or Codex's own `unexpected status 429`), since `other` and `usageLimitExceeded` carry none.
 */
function errorStatus(e) {
  const known = statusOf(e?.codexErrorInfo);
  if (known !== undefined) return known;
  const m = /"status"\s*:\s*(\d{3})\b|\bunexpected status (\d{3})\b/.exec(typeof e?.message === 'string' ? e.message : '');
  return m ? Number(m[1] ?? m[2]) : undefined;
}

/** The codexErrorInfo's kind: the string itself, or the object's one key. */
const codeOf = (info) => (typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined);

/** A TurnError's text: its message, and the details the server sent (the limit's wording, say). */
function errorOf(e) {
  if (!e || typeof e !== 'object') return undefined;
  return [e.message, e.additionalDetails].filter((s) => typeof s === 'string' && s).join(' — ') || undefined;
}

/** Turns tracked at once; far more than run in parallel. */
const MAX_TURNS = 256;

class CodexLedgerTap {
  /**
   * @param {object} o
   * @param {(r: LedgerRecord) => unknown} o.record
   * @param {(threadId: string) => string} o.chatOf the MoPilot chat a thread belongs to
   * @param {(threadId: string, turnId: string) => LedgerAccount | null} o.accountOf the login the turn runs on
   */
  constructor(o) {
    this.recordFn = o.record;
    this.chatOf = o.chatOf;
    this.accountOf = o.accountOf;
    /** @type {Map<string, CodexTurn>} by turn id */
    this.turns = new Map();
    /** the model provider each thread started on (thread/started), newest last @type {Map<string, string>} */
    this.providers = new Map();
  }

  /** The adapter's own events: turnStarted carries the model and effort turn/start asked for. */
  emitted(e) {
    if (e?.kind !== 'turnStarted' || typeof e.turnId !== 'string') return;
    const t = this.turns.get(e.turnId) ?? { thread: '' };
    if (typeof e.model === 'string' && e.model) t.req = e.model;
    if (typeof e.effort === 'string' && e.effort) t.effort = e.effort;
    if (typeof e.chatId === 'string') t.chat = e.chatId;
    this.turns.set(e.turnId, t);
    // a turn that ended before its turnStarted came is never completed here: the oldest such entries go
    if (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value);
  }

  /** A raw app-server message, before its thread id is mapped to the chat. */
  message(msg) {
    const p = msg?.params;
    if (!p || typeof msg.method !== 'string') return;
    if (msg.method === 'thread/started' && typeof p.thread?.id === 'string' && typeof p.thread.modelProvider === 'string') {
      this.providers.delete(p.thread.id);
      this.providers.set(p.thread.id, p.thread.modelProvider);
      if (this.providers.size > MAX_TURNS) this.providers.delete(this.providers.keys().next().value);
      return;
    }
    if (msg.method === 'turn/started' && typeof p.turn?.id === 'string' && typeof p.threadId === 'string') {
      /** @type {CodexTurn} */
      const t = this.turns.get(p.turn.id) ?? { thread: p.threadId };
      this.turns.set(p.turn.id, t);
      t.thread = p.threadId;
      t.chat = this.chatOf(p.threadId);
      // read now: the login a turn started on is forgotten at turn/completed, before this tap sees it (behind the relay
      // the thread's pin comes with its first request, so record() asks again while it is unknown)
      t.account = this.accountOf(p.threadId, p.turn.id);
      return;
    }
    const turnId = msg.method === 'turn/completed' ? p.turn?.id : p.turnId;
    // a turn this tap did not see start (a resumed thread's old usage, a helper thread) is not a request of this run
    const t = typeof turnId === 'string' ? this.turns.get(turnId) : undefined;
    if (!t?.thread) return;
    if (msg.method === 'model/rerouted') {
      if (typeof p.toModel === 'string') t.served = p.toModel;
    } else if (msg.method === 'thread/tokenUsage/updated') {
      const last = p.tokenUsage?.last;
      if (!last) return;
      // a stopped turn repeats its last update: a new request always adds to the thread's total
      const total = p.tokenUsage.total?.totalTokens;
      if (typeof total === 'number' && total === t.total) return;
      t.total = total;
      this.record(t, turnId, {
        outcome: 'ok',
        // the thread's running total names this request; the rollout's token_count events carry the same total
        key: typeof total === 'number' ? `${t.thread}:${total}` : undefined,
        // inputTokens counts the cached part too; the ledger's `in` is what was not read from the cache
        in: typeof last.inputTokens === 'number' ? last.inputTokens - (last.cachedInputTokens ?? 0) : undefined,
        cacheRead: last.cachedInputTokens,
        cacheWrite: last.cacheWriteInputTokens,
        out: last.outputTokens,
        reasoning: last.reasoningOutputTokens,
      });
    } else if (msg.method === 'error') {
      if (!p.willRetry) t.errored = true;
      this.record(t, turnId, {
        outcome: p.willRetry ? 'retry' : 'error',
        status: errorStatus(p.error),
        code: codeOf(p.error?.codexErrorInfo),
        error: errorOf(p.error),
      });
    } else if (msg.method === 'turn/completed') {
      const status = p.turn.status;
      if (status === 'interrupted') this.record(t, turnId, { outcome: 'interrupted' });
      else if (status === 'failed' && !t.errored)
        this.record(t, turnId, {
          outcome: 'error',
          status: errorStatus(p.turn.error),
          code: codeOf(p.turn.error?.codexErrorInfo),
          error: errorOf(p.turn.error),
        });
      this.turns.delete(turnId);
    }
  }

  /**
   * How a turn's requests are paid for: as its login bills, except that a thread on another model provider than Codex's own
   * (an added key a resumed thread kept, #2213, or the user's config.toml) is no plan login's, whatever login is held.
   * @param {CodexTurn} t
   */
  payOf(t) {
    const pay = t.account?.pay ?? 'unknown';
    const provider = this.providers.get(t.thread);
    return pay === 'plan' && provider !== undefined && provider !== 'openai' ? 'unknown' : pay;
  }

  /** @param {CodexTurn} t @param {string} turnId @param {Omit<LedgerRecord, 'harness'>} r */
  record(t, turnId, r) {
    t.account ??= this.accountOf(t.thread, turnId);
    this.recordFn({
      harness: 'codex',
      chat: t.chat,
      session: t.thread,
      turn: turnId,
      account: t.account,
      pay: this.payOf(t),
      req: t.req,
      served: t.served,
      effort: t.effort,
      ...r,
    });
  }
}

module.exports = { CodexLedgerTap, statusOf, errorStatus, codeOf };
