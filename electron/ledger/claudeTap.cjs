// The request ledger's Claude Code tap: the stream-json messages main receives for each session become ledger records.
// One API request is one assistant message id; its usage is kept until the request is over (the next id on the same
// thread, the result or the process ending), so the line has the final counts. A tool result does not end it: the CLI
// runs a tool as soon as its block is complete, so the same message's next blocks can come after that result. The chat's own
// thread and each subagent's (parent_tool_use_id) keep their open request apart, since parallel subagents interleave.
// Errors come as a CLI-made assistant message with `error` set, a system api_retry, or an is_error result; a stop
// shows as the CLI's interrupt marker. A real reply's words are never read, even when it carries an error.

const { claudeResultErrors, claudeResultFailed } = require('../../shared/claudeResult.mjs');

/**
 * @typedef {import('./line.cjs').LedgerRecord} LedgerRecord
 * @typedef {import('./line.cjs').LedgerAccount} LedgerAccount
 * @typedef {{ id: string, served?: string, usage?: any, code?: string, done?: boolean }} Pending
 * @typedef {{ session?: string, req?: string, pending: Map<string, Pending>, errored: boolean, interrupted: boolean,
 *   stopWritten: boolean, busy: boolean, account?: LedgerAccount | null }} ClaudeSession
 */

/** The marker the CLI writes as a user message when a turn is stopped (electron/session/contract/reconcile.cjs). */
const INTERRUPT = /^\s*\[Request interrupted by user/;

/** The text blocks of a message's content (an error message's wording). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

/** Whether a user message is only the CLI's interrupt marker (its text is never kept). */
const interrupts = (content) => INTERRUPT.test(textOf(content) ?? '');

/** The thread a message is on: '' for the chat's own, a subagent's tool use id for the subagent's. */
const laneOf = (m) => (typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : '');

class ClaudeLedgerTap {
  /**
   * @param {object} o
   * @param {(r: LedgerRecord) => unknown} o.record
   * @param {(key: string) => string} o.chatOf the MoPilot chat a session key belongs to
   * @param {(evt: { key: string, login?: boolean, account?: string }) => LedgerAccount | null} o.accountOf the account the
   *   session's turns run on, as MoPilot resolved it (electron/harness/claude/index.cjs ledgerAccount)
   */
  constructor(o) {
    this.recordFn = o.record;
    this.chatOf = o.chatOf;
    this.accountOf = o.accountOf;
    /** @type {Map<string, ClaudeSession>} by session key */
    this.sessions = new Map();
  }

  /** @param {string} key @returns {ClaudeSession} */
  session(key) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { pending: new Map(), errored: false, interrupted: false, stopWritten: false, busy: false };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** An event electron/harness/claude/index.cjs emits for a session (kind message, closed, error, ...). */
  event(evt) {
    if (typeof evt?.key !== 'string') return;
    if (evt.kind === 'closed' || evt.kind === 'error') return this.ended(evt);
    if (evt.kind !== 'message' || !evt.msg) return;
    const m = evt.msg;
    const s = this.session(evt.key);
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id === 'string') s.session = m.session_id;
      if (typeof m.model === 'string') s.req = m.model;
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      s.busy = true;
      this.record(evt, s, { outcome: 'retry', status: m.error_status ?? undefined, code: m.error });
    } else if (m.type === 'assistant') {
      s.busy = true;
      const msg = m.message ?? {};
      const lane = laneOf(m);
      // the CLI's own error message (no request id, model <synthetic>): its words are the API's error
      if (m.error && (msg.model === '<synthetic>' || typeof msg.id !== 'string')) {
        this.flushLane(evt, s, lane);
        s.errored = true;
        this.record(evt, s, { outcome: 'error', code: m.error, error: textOf(msg.content) });
        return;
      }
      if (typeof msg.id !== 'string') return;
      let p = s.pending.get(lane);
      if (!p || p.id !== msg.id) {
        this.flushLane(evt, s, lane);
        p = { id: msg.id };
        s.pending.set(lane, p);
      }
      if (typeof msg.model === 'string') p.served = msg.model;
      if (msg.usage) p.usage = msg.usage;
      // a real reply the API cut short (max_output_tokens, say): the request failed; its words stay out of the ledger
      if (m.error) {
        p.code = m.error;
        s.errored = true;
      }
    } else if (m.type === 'user' && interrupts(m.message?.content)) {
      // a stop cuts the open request on every thread
      s.interrupted = true;
      this.flushAll(evt, s);
    } else if (m.type === 'user') {
      // a tool's result: its request finished (more of its blocks may still come), so a stop now does not cut it
      const p = s.pending.get(laneOf(m));
      if (p) p.done = true;
    } else if (m.type === 'result') {
      this.settle(evt, s, m);
    }
  }

  /** A result ends the turn (or a prompt sent into it): the open request is written, then how the turn ended. */
  settle(evt, s, m) {
    this.flushAll(evt, s);
    // the marker usually comes first and already wrote the cut request as stopped
    if (s.interrupted && !s.stopWritten) this.record(evt, s, { outcome: 'interrupted' });
    // `result` may be the model's last words, so only the CLI's own `errors` are kept; its diagnostics alone are no error
    else if (!s.interrupted && m.is_error && claudeResultFailed(m) && !s.errored)
      this.record(evt, s, {
        outcome: 'error',
        code: m.subtype,
        error: Array.isArray(m.errors) ? claudeResultErrors(m).join('; ') : undefined,
      });
    Object.assign(s, { errored: false, interrupted: false, stopWritten: false, busy: false, account: undefined });
  }

  /** The process ended: its open requests are written; one that died mid-turn fails them, or adds an error, with its reason. */
  ended(evt) {
    const s = this.sessions.get(evt.key);
    if (!s) return;
    const failure = evt.kind === 'error' && s.busy && !s.errored ? String(evt.error ?? '') : undefined;
    if (!this.flushAll(evt, s, failure) && failure !== undefined) this.record(evt, s, { outcome: 'error', error: failure });
    this.sessions.delete(evt.key);
  }

  /** Writes every open request; true when one was written. */
  flushAll(evt, s, failure) {
    const wrote = s.pending.size > 0;
    for (const lane of [...s.pending.keys()]) this.flushLane(evt, s, lane, failure);
    return wrote;
  }

  /**
   * Writes a thread's open request, if any: stopped when the turn was, failed when it carried an error or the process
   * died (`failure`); true when one was written.
   */
  flushLane(evt, s, lane, failure) {
    const p = s.pending.get(lane);
    if (!p) return false;
    s.pending.delete(lane);
    const cut = s.interrupted && !p.done;
    if (cut) s.stopWritten = true;
    const u = p.usage ?? {};
    this.record(evt, s, {
      key: p.id,
      outcome: cut ? 'interrupted' : failure !== undefined || p.code ? 'error' : 'ok',
      code: p.code,
      error: failure,
      served: p.served === '<synthetic>' ? undefined : p.served,
      in: u.input_tokens,
      out: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
    });
    return true;
  }

  /** @param {any} evt @param {ClaudeSession} s @param {Omit<LedgerRecord, 'harness'>} r */
  record(evt, s, r) {
    // the account is read once per turn: it is the session's login, which a turn does not change
    if (s.account === undefined) s.account = this.accountOf(evt);
    this.recordFn({
      harness: 'claude',
      chat: this.chatOf(evt.key),
      session: s.session ?? evt.key.replace(/^claude:/, ''),
      account: s.account,
      pay: s.account?.pay,
      req: s.req,
      ...r,
    });
  }
}

module.exports = { ClaudeLedgerTap };
