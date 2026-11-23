// A code review's findings applied without a click (Settings → General, or a chat whose PR monitor has Auto-fix on): main
// reads each harness's review from its live events and, once the review's turn ends well, sends the chat the fix request
// Apply fixes sends, on every harness and with no window open.
const crypto = require('node:crypto');
const {
  reportedFindings,
  parseCodexReview,
  isReReport,
  applyFixesRequest,
  APPLY_REVIEW_REQUEST,
  findingLocation,
  rowLabel,
} = require('../../shared/reviewFindings.mjs');
const { isReviewAsk } = require('../../shared/reviewAsk.mjs');
const { contentBlocks } = require('../../shared/contentBlocks.mjs');
const { authoredOr } = require('./authoredInput.cjs');

/** ReportFindings calls per chat waiting for their result. */
const MAX_PENDING = 50;
/** Fix requests sent and not yet dispatched (one that never is, a send the chat kept queued and the user removed, ages out). */
const MAX_SENT = 100;
/** A review that posts its findings to the PR (/code-review --comment), where a monitored PR's Auto-fix applies them. */
const POSTS = /(?:^|\s)--comment(?:\s|$)/;

/**
 * How windows show a fix request main sent: MoPilot's, never the user's words; its findings named behind Show details.
 * @param {ReviewFinding[] | null} findings null: the review's prose
 * @returns {Shown}
 */
function shown(findings) {
  if (!findings) return { by: 'mopilot', title: 'Applying the code review’s findings' };
  const n = findings.length;
  return {
    by: 'mopilot',
    title: `Applying ${n === 1 ? 'the code review’s finding' : `the code review’s ${n} findings`}`,
    body: findings.map((f) => `${findingLocation(f)}: ${rowLabel(f)}`).join('\n'),
  };
}

/**
 * @typedef {import('../../shared/reviewFindings.d.mts').ReviewFinding} ReviewFinding
 * @typedef {{ by: string, title: string, body?: string | null }} Shown how windows show an input main sent
 * @typedef {{ prompt: string, auto: boolean, review: { findings: ReviewFinding[], reReported: boolean } | null,
 *   answered: boolean }} TurnReview the chat's running turn as auto-fix reads it: the prompt that started it, whether
 *   this service sent it, its latest review, and whether anything was sent into the turn after that review
 */

class ReviewAutoFix {
  /**
   * @param {object} o
   * @param {(chatId: string) => boolean} o.exists the chat is still there
   * @param {() => boolean} o.setting Settings applies every chat's findings without a click
   * @param {(chatId: string) => boolean} o.prAutoFix the chat's open PR is monitored with Auto-fix, which applies them too
   * @param {(chatId: string) => boolean} o.reportTool the chat's harness reports outcomes through ReportFindings
   * @param {(key: string) => string} o.chatOf a Claude Code or ACP session's chat (ChatController.chatOf)
   * @param {(thread: string) => string} o.requestThread the thread a Codex thread's requests show in: itself unless it is a
   *   sub-agent's (ChatController.requestThread)
   * @param {(chatId: string) => number} o.queued how many messages wait in the chat's queue
   * @param {(chatId: string) => string | null} o.blocked why the chat can't take a message now (prMonitor's gate)
   * @param {(chatId: string, item: object) => unknown} o.send the item into the chat (ChatController.send)
   * @param {(what: string, error: unknown) => void} o.note a failure no one waits for
   * @param {(fn: () => void) => void} [o.later] runs once the turn's end has settled (the queue drained first)
   * @param {(chatId: string, text: string, show: Shown) => { id?: string }} [o.make] the item with how windows show it
   *   (authoredInput over main's chats); without one, the same item shown as the harness has it
   */
  constructor(o) {
    this.o = o;
    this.later = o.later ?? ((fn) => setImmediate(fn));
    /** @type {Map<string, TurnReview>} */
    this.turns = new Map();
    /** @type {Map<string, Map<string, unknown>>} chat → ReportFindings call id → its input */
    this.calls = new Map();
    /** ids of the fix requests this service sent, until their dispatch */
    this.sent = new Set();
  }

  /** @param {string} chatId @returns {TurnReview} */
  turnOf(chatId) {
    let turn = this.turns.get(chatId);
    if (!turn) this.turns.set(chatId, (turn = { prompt: '', auto: false, review: null, answered: false }));
    return turn;
  }

  /** A message going to a chat (ChatController.beforeDispatch): a turn starts over; a steer answers the turn's review. */
  dispatching({ chatId, kind, item }) {
    if (kind === 'turn') {
      const auto = this.sent.delete(item?.id);
      this.turns.set(chatId, { prompt: typeof item?.text === 'string' ? item.text : '', auto, review: null, answered: false });
    } else if (this.turns.get(chatId)?.review) this.turnOf(chatId).answered = true;
  }

  /**
   * One live event of a harness family (ChatController.onLiveEvent), read by that family's reader below. A basic
   * harness's review is prose with no typed result: its turn's prompt and reply are read when it ends.
   */
  event(family, e) {
    const read = { codex: this.codex, claude: this.claude, acp: null }[family];
    read?.call(this, e);
  }

  /** Codex's review result (review/start): its text in Codex's format; a sub-agent's review is not the chat's. */
  codex(msg) {
    const p = msg?.params;
    if (msg?.method !== 'item/completed' || p?.item?.type !== 'exitedReviewMode' || typeof p.threadId !== 'string') return;
    if (this.o.requestThread(p.threadId) !== p.threadId) return;
    const parsed = parseCodexReview(String(p.item.review ?? ''));
    this.reported(this.o.chatOf(p.threadId), parsed?.findings ?? []);
  }

  /** Claude Code's ReportFindings call, counted once its result says the CLI took it (as the review card counts it). */
  claude(e) {
    const m = e?.msg;
    if (e?.kind !== 'message' || m?.parent_tool_use_id || !Array.isArray(m?.message?.content)) return;
    const chatId = this.o.chatOf(e.key);
    for (const b of contentBlocks(m.message.content)) {
      if (m.type === 'assistant' && b?.type === 'tool_use' && b.name === 'ReportFindings' && typeof b.id === 'string') {
        const calls = this.calls.get(chatId) ?? new Map();
        calls.set(b.id, b.input);
        if (calls.size > MAX_PENDING) calls.delete(calls.keys().next().value);
        this.calls.set(chatId, calls);
      } else if (m.type === 'user' && b?.type === 'tool_result') {
        const id = String(b.tool_use_id);
        const calls = this.calls.get(chatId);
        if (!calls?.has(id)) continue;
        const input = calls.get(id);
        calls.delete(id);
        if (b.is_error !== true) this.reported(chatId, reportedFindings(input).findings);
      }
    }
  }

  /** A review in the chat's turn, or its outcomes after fixes (/code-review --fix, or a fix turn's re-report). */
  reported(chatId, findings) {
    const turn = this.turnOf(chatId);
    if (isReReport(findings)) {
      if (turn.review) turn.review.reReported = true;
    } else {
      turn.review = { findings, reReported: false };
      turn.answered = false;
    }
  }

  /**
   * What the finished turn's review asks the chat to fix next, or null: the findings of a review no one acted on, or for
   * a review ask whose findings came as prose (a basic harness's /review, a plain-words review), the review's own text.
   * @param {string} chatId @param {TurnReview} turn @param {string | null} text the turn's last reply
   * @returns {{ text: string, show: Shown } | null}
   */
  request(chatId, turn, text) {
    const reportTool = this.o.reportTool(chatId);
    if (turn.review) {
      const { findings, reReported } = turn.review;
      return findings.length && !reReported ? { text: applyFixesRequest(findings, { reportTool }), show: shown(findings) } : null;
    }
    if (!isReviewAsk(turn.prompt) || !text?.trim()) return null;
    const parsed = parseCodexReview(text);
    return parsed
      ? { text: applyFixesRequest(parsed.findings, { reportTool }), show: shown(parsed.findings) }
      : { text: APPLY_REVIEW_REQUEST, show: shown(null) };
  }

  /** Whether the chat applies findings without a click now. */
  enabled(chatId) {
    return this.o.exists(chatId) && (this.o.setting() || this.o.prAutoFix(chatId));
  }

  /** A turn ended (ChatController.onFinished): one that ended well with findings to fix sends the fix, once. */
  finished({ chatId, completed, text }) {
    const turn = this.turns.get(chatId);
    this.turns.delete(chatId);
    this.calls.delete(chatId);
    // its own fix turn, and a review someone already answered in the turn, are not reviews to apply
    if (!turn || !completed || turn.auto || turn.answered) return;
    // a message the user queued behind the review goes first, and the review's findings stay theirs to apply
    if (!this.enabled(chatId) || this.o.queued(chatId) > 0) return;
    // findings posted to a PR whose Auto-fix is on reach the chat from there, as inline comments: applied once
    if (POSTS.test(turn.prompt) && this.o.prAutoFix(chatId)) return;
    const ask = this.request(chatId, turn, typeof text === 'string' ? text : null);
    if (!ask) return;
    this.later(() => {
      try {
        if (!this.enabled(chatId) || this.o.blocked(chatId)) return;
        const item = /** @type {{ id?: string }} */ (authoredOr(this.o.make, chatId, ask.text, ask.show));
        const id = item.id ?? crypto.randomUUID();
        this.sent.add(id);
        if (this.sent.size > MAX_SENT) this.sent.delete(this.sent.values().next().value);
        const sent = this.o.send(chatId, { ...item, id });
        Promise.resolve(sent).catch((error) => this.o.note('apply a review’s findings', error));
      } catch (error) {
        this.o.note('apply a review’s findings', error);
      }
    });
  }

  /** A deleted chat leaves nothing behind. */
  forget(chatId) {
    this.turns.delete(chatId);
    this.calls.delete(chatId);
  }
}

module.exports = { ReviewAutoFix, MAX_PENDING, MAX_SENT };
