// Each chat's context snapshot in main, on every harness and with no window open: Codex and ACP token reports and Claude Code's own breakdown (read when its turn ends) become one snapshot per owner ([chat, harness, native id]), published to the windows and kept on disk.
const { noteIgnored } = require('../ignored.cjs');
const { withTimeout } = require('../platform/timeout.cjs');
const { codexCompaction, claudeCompaction } = require('../harness/compactionSignals.cjs');
const { tokenUsage } = require('../../shared/claudeItems/tokenUsage.mjs');
const {
  emptySnapshot,
  withTokens,
  withClaudeBreakdown,
  fromTokenUsage,
  fromAcpUsage,
  addBreakdowns,
  baselineOf,
  costOf,
  count,
} = require('../../shared/contextSnapshot.mjs');

/**
 * @typedef {import('../../shared/contextSnapshot.mjs').ContextSnapshot} ContextSnapshot
 * @typedef {'summary' | 'full'} Detail
 * @typedef {{ firstChars: number | null, fresh: boolean, turns: number, counted: string[], seq: number,
 *   reading: Promise<ContextSnapshot | null> | null, again: Detail | null }} OwnerState
 */

/** Turn ids remembered per owner, so a turn's usage is added to the session once. */
const COUNTED = 32;
/** Owners whose read state is kept; older ones go first (a helper thread's never comes back). */
const MAX_STATES = 1000;
/** How long a breakdown read may take before it counts as failed: a summary is local, a full read counts by the API. */
const READ_MS = { summary: 15_000, full: 90_000 };
const text = (v) => (typeof v === 'string' && v ? v : null);
/** The characters of a message's text blocks (a prompt's share of its first request). */
const charsOf = (content) =>
  (Array.isArray(content) ? content : []).reduce((n, b) => n + (b?.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0);
/** The owner key every display filters by (src/store/contextUsage.ts contextUsageKey). */
const ownerKey = (chatId, harness, nativeId) => JSON.stringify([chatId, harness, nativeId]);
/** An owner key's parts, or null when it is not one. */
function parseOwner(owner) {
  try {
    const v = JSON.parse(String(owner));
    return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string' && x)
      ? { chatId: v[0], harness: v[1], nativeId: v[2] }
      : null;
  } catch {
    return null;
  }
}

class ContextService {
  /**
   * @param {object} o
   * @param {{ get: (owner: string) => ContextSnapshot | null, put: (s: ContextSnapshot) => void }} o.store
   * @param {(chatId: string, snapshot: ContextSnapshot) => void} o.publish to the windows
   * @param {(nativeId: string) => string} o.chatOf a native thread id or session key to its MoPilot chat
   * @param {Record<string, (nativeId: string, detail: Detail) => Promise<unknown>>} o.readers by harness, a session's own
   *   breakdown (Claude Code's get_context_usage answer); a harness with none reports token counts only
   * @param {() => number} [o.now]
   * @param {{ summary: number, full: number }} [o.readMs] how long a read may take
   */
  constructor(o) {
    this.store = o.store;
    this.publish = o.publish;
    this.chatOf = o.chatOf;
    this.readers = o.readers;
    this.now = o.now ?? Date.now;
    this.readMs = o.readMs ?? READ_MS;
    /** @type {Map<string, OwnerState>} */
    this.owners = new Map();
  }

  /** @param {string} owner @returns {OwnerState} */
  state(owner) {
    let s = this.owners.get(owner);
    if (!s) {
      s = { firstChars: null, fresh: false, turns: 0, counted: [], seq: 0, reading: null, again: null };
      this.owners.set(owner, s);
      for (const [old, o] of this.owners) {
        if (this.owners.size <= MAX_STATES) break;
        if (!o.reading) this.owners.delete(old);
      }
    }
    return s;
  }

  /** The owner's snapshot, or null while nothing was measured for it. */
  get(owner) {
    return parseOwner(owner) ? this.store.get(owner) : null;
  }

  /** @param {string} owner @param {(prev: ContextSnapshot) => ContextSnapshot | null} change */
  update(owner, change) {
    const prev = this.store.get(owner) ?? emptySnapshot(owner, this.now());
    const next = change(prev);
    // no change: what is stored (nothing, when nothing was measured yet)
    if (!next || next === prev) return this.store.get(owner);
    this.store.put(next);
    const parts = parseOwner(owner);
    if (parts) this.publish(parts.chatId, next);
    return next;
  }

  /** A raw Codex app-server notification (electron/app/sessions.cjs observe). */
  codexMessage(msg) {
    const p = msg?.params;
    const raw = text(p?.threadId);
    if (!raw) return;
    const owner = ownerKey(this.chatOf(raw), 'codex', raw);
    if (msg.method === 'thread/tokenUsage/updated') {
      const report = fromTokenUsage(p.tokenUsage);
      const st = this.state(owner);
      this.update(owner, (prev) => {
        // the thread's first request (its total is that request alone): what it sent less the message is the baseline
        const first = report.session && report.lastRequest && report.session.totalTokens === report.lastRequest.totalTokens;
        const baseline = prev.baseline ?? (first ? baselineOf(report.lastRequest?.inputTokens, st.firstChars) : null);
        return withTokens({ ...prev, baseline }, { ...report, at: this.now() });
      });
    } else if (msg.method === 'item/started' && p.item?.type === 'userMessage') {
      const st = this.state(owner);
      if (st.firstChars === null) st.firstChars = charsOf(p.item.content);
    } else if (codexCompaction(msg)?.phase === 'complete') this.compacted(owner);
  }

  /** An ACP host event (electron/harness/acp.cjs), keyed `acp:<harness>:<chat>`. */
  acpEvent(e) {
    const m = /^acp:([^:]+):.+$/.exec(String(e?.key ?? ''));
    if (!m) return;
    const owner = ownerKey(this.chatOf(e.key), `acp:${m[1]}`, e.key);
    const st = this.state(owner);
    if (e.kind === 'session') {
      st.fresh = e.fresh === true;
      st.turns = 0;
      // a new session (one that could not be reopened is replaced by one) starts with nothing measured
      if (st.fresh) {
        st.counted = [];
        this.update(owner, (prev) => (prev.used === null && !prev.session ? null : emptySnapshot(owner, this.now())));
      }
    } else if (e.kind === 'turnStart') {
      if (st.turns++ === 0) st.firstChars = charsOf(e.user?.content);
    } else if (e.kind === 'update' && e.update?.sessionUpdate === 'usage_update') {
      const used = count(e.update.used);
      if (used === null) return;
      this.update(owner, (prev) => {
        // a new session's first prompt: what its context holds less the message is the baseline
        const first = st.fresh && st.turns === 1 && e.turnId !== null;
        const baseline = prev.baseline ?? (first ? baselineOf(used, st.firstChars) : null);
        const cost = costOf(e.update.cost) ?? prev.cost;
        return withTokens({ ...prev, baseline, cost }, { used, window: e.update.size ?? null, at: this.now() });
      });
    } else if (e.kind === 'turnEnd') {
      const usage = fromAcpUsage(e.usage);
      const id = text(e.turnId);
      if (!usage || (id && st.counted.includes(id))) return;
      if (id) st.counted = [...st.counted, id].slice(-COUNTED);
      this.update(owner, (prev) => withTokens(prev, { lastRequest: usage, session: addBreakdowns(prev.session, usage), at: this.now() }));
    }
  }

  /** A Claude Code session event (electron/harness/claude/index.cjs observe). */
  claudeEvent(evt) {
    const key = text(evt?.key);
    if (!key || evt.kind !== 'message' || !evt.msg) return;
    const owner = ownerKey(this.chatOf(key), 'claude', key);
    const m = evt.msg;
    const signal = claudeCompaction(evt);
    if (signal?.phase === 'reset' || signal?.phase === 'complete') {
      // a read already under way measured the conversation before this: its answer is dropped
      this.state(owner).seq++;
      if (signal.phase === 'reset') this.update(owner, (prev) => ({ ...emptySnapshot(owner, this.now()), model: prev.model }));
      else this.compacted(owner);
    } else if (m.type === 'result' && typeof m.parent_tool_use_id !== 'string') {
      // the chat's own turn ended (a subagent's result is its own): its tokens now, its breakdown read next
      const prevSession = this.store.get(owner)?.session;
      const report = fromTokenUsage(tokenUsage(m, prevSession ? { total: prevSession } : undefined));
      // Claude Code's breakdown names the window it runs with; a result's model list may lead with another model
      this.update(owner, (prev) =>
        withTokens(prev, { ...report, window: prev.quality === 'breakdown' ? undefined : report.window, at: this.now() }),
      );
      this.refresh(owner, 'summary').catch((error) => noteIgnored("read a Claude Code chat's context breakdown", error));
    }
  }

  /** A compaction finished: the categories describe what was there before it until the next read. */
  compacted(owner) {
    this.update(owner, (prev) => (prev.used === null ? null : { ...prev, stale: 'compacted', at: this.now() }));
  }

  /**
   * Read the owner's breakdown again where its harness has a reader (Claude Code); the snapshot as it stands elsewhere.
   * One read per owner at a time: an ask while one runs is answered by the read after it (the fuller of the details
   * asked), and an answer for an owner a newer read replaced is dropped. A failed read keeps the last snapshot, marked.
   * @param {string} owner @param {Detail} [detail] @returns {Promise<ContextSnapshot | null>}
   */
  async refresh(owner, detail = 'summary') {
    const parts = parseOwner(owner);
    if (!parts) return null;
    const reader = Object.hasOwn(this.readers, parts.harness) ? this.readers[parts.harness] : null;
    if (!reader) return this.store.get(owner);
    const st = this.state(owner);
    if (st.reading) {
      st.again = st.again === 'full' || detail === 'full' ? 'full' : 'summary';
      // read() answers failures itself, so the read under way never rejects; the one after it is the answer
      await st.reading;
      return st.reading ?? this.store.get(owner);
    }
    const seq = ++st.seq;
    st.reading = this.read(owner, () => this.timed(reader(parts.nativeId, detail), this.readMs[detail]), seq).finally(() => {
      st.reading = null;
      const again = st.again;
      st.again = null;
      if (again) this.refresh(owner, again).catch((error) => noteIgnored("read a Claude Code chat's context breakdown again", error));
    });
    return st.reading;
  }

  /** A read that does not answer in time fails, so a stalled session never holds its owner's reads. */
  timed(pending, ms) {
    return withTimeout(pending, ms, `no answer in ${ms / 1000}s`);
  }

  /** @param {string} owner @param {() => Promise<unknown>} ask @param {number} seq */
  async read(owner, ask, seq) {
    const st = this.state(owner);
    try {
      const reply = await ask();
      if (st.seq !== seq) return this.store.get(owner);
      return this.update(owner, (prev) => withClaudeBreakdown(prev, reply, this.now()));
    } catch (error) {
      noteIgnored("read a Claude Code chat's context breakdown", error);
      if (st.seq !== seq) return this.store.get(owner);
      return this.update(owner, (prev) => (prev.quality === 'breakdown' ? { ...prev, stale: 'refresh-failed' } : null));
    }
  }
}

module.exports = { ContextService, ownerKey, parseOwner };
