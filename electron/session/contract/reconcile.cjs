// External writes (WP5-19, design §07): another client (the official Codex app, Claude desktop, a CLI
// in a terminal) can run a turn on a chat Sage has open. Its rollout or jsonl file is the only trace,
// so main watches it, and on each write reconciles: re-reads the native state and records in the
// chat's SessionState whether another app is running a turn on it. Windows grey out the Composer
// while it is (caps: session.runningElsewhere).
const { clock } = require('../../platform/ports/clock.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { endsClaudeTurn } = require('../../../shared/claudeEndTurn.mjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { matchesSource } = require('./route.cjs');

/** A writer that has been silent this long has probably quit without finishing its turn. */
const SILENT_MS = 60_000;

/** A Codex turn read from disk that is still going (the app-server reads another client's open turn as interrupted with no end). */
const codexUnfinished = (t) =>
  !!t && (t.status === 'inProgress' || (t.status === 'interrupted' && t.completedAt == null && t.durationMs == null));

/** The text of a user record (a string, or its first text block). */
const userText = (d) => {
  const c = d.message?.content;
  const text = typeof c === 'string' ? c : String(contentBlocks(c).find((b) => b.type === 'text')?.text ?? '');
  return text.trimStart();
};

/** The record the CLI injects when a background task finishes: its own bookkeeping, not anyone's prompt. */
const isTaskNotification = (d) => userText(d).startsWith('<task-notification>');

/** The record the CLI writes when the user stops a turn ("[Request interrupted by user for tool use]"): the turn is over, not running. */
const isInterrupt = (d) => userText(d).startsWith('[Request interrupted by user');

const DONE = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
/**
 * Whether a Claude transcript's tail is mid-turn: the last user or assistant record is a prompt, a
 * tool result (other than one that ended the turn), or an assistant message that hasn't stopped (tool_use, or still streaming).
 * @param {string[]} lines the transcript's last lines
 */
function claudeTailRunning(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    if (d.type === 'assistant') return !DONE.has(d.message?.stop_reason);
    // a local command's output or a meta record isn't the model working
    // a notification is written just before the CLI starts answering it: the answer that follows shows the turn running
    // a tool result that ended the turn (Claude Code's end-turn flag: a wrap-up box) is the turn's last word
    if (d.type === 'user') return !d.isMeta && !d.isCompactSummary && !isTaskNotification(d) && !isInterrupt(d) && !endsClaudeTurn(d);
  }
  return false;
}

/**
 * The last whole lines of a file, read from `bytes` before its end. A window that starts inside a line leaves that
 * piece out, and one with no whole line (a last record bigger than it, such as a screenshot) is doubled, up to `max`.
 */
function tailLines(file, bytes = 256 * 1024, max = 16 * 1024 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      for (let want = bytes; ; want *= 2) {
        // one byte more than the window: the piece before its first line break is cut (or empty), not a line
        const from = Math.max(0, size - Math.min(size, want) - 1);
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        const lines = buf.toString('utf8').split('\n');
        if (from > 0) lines.shift();
        const whole = lines.filter(Boolean);
        if (whole.length || from === 0 || want >= max) return whole;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Whether the chat already has a MoPilot turn, rather than an external writer. */
function localTurnRunning(state, chatId) {
  const s = state?.has(chatId) ? state.get(chatId) : null;
  return !!s && (s.turn === 'running' || s.turn === 'awaitingUser');
}

class ExternalWrites {
  /**
   * @param {object} o
   * @param o.state SessionStore
   * @param [o.isCurrent] (chatId, source) => whether the source is still the selected native session
   * @param [o.now] () => ms
   * @param [o.mtime] (file) => ms, the file's last write
   * @param [o.silentMs] how long a writer stays silent before the chat is checked again
   */
  constructor(o) {
    this.state = o.state;
    this.isCurrent = o.isCurrent;
    this.now = o.now ?? (() => clock.now());
    this.mtime = o.mtime ?? mtimeOf;
    this.silentMs = o.silentMs ?? SILENT_MS;
    /** chat -> the check that runs again once the writer may have gone silent */
    this.timers = new Map();
    /** Latest read or silence timer per chat; forgetting removes its authority to publish. */
    this.checks = new Map();
  }

  sourceCurrent(chatId, source) {
    return !source || !this.isCurrent || this.isCurrent(chatId, source);
  }

  checkCurrent(chatId, check) {
    if (this.checks.get(chatId) !== check) return false;
    if (!this.sourceCurrent(chatId, check.source) || this.state.localWriterToken?.(chatId) !== check.writer) {
      this.forget(chatId, check.source);
      return false;
    }
    return true;
  }

  /**
   * Re-read a chat another app may be writing: `running` (async) says whether the native state shows
   * a turn still going that isn't Sage's; a file not written for a while has no writer any more.
   */
  async reconcile(chatId, file, running, source) {
    if (!chatId) return false;
    if (!this.sourceCurrent(chatId, source)) {
      this.forget(chatId, source);
      return false;
    }
    clock.clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
    const check = { source, writer: this.state.localWriterToken?.(chatId) };
    this.checks.set(chatId, check);
    let at = file ? this.mtime(file) : this.now();
    const quiet = this.now() - at >= this.silentMs;
    let on = false;
    if (!quiet && !localTurnRunning(this.state, chatId)) {
      try {
        on = !!(await running());
      } catch {
        on = false;
      }
    }
    if (!this.checkCurrent(chatId, check)) return false;
    if (on) {
      at = file ? this.mtime(file) : this.now();
      if (localTurnRunning(this.state, chatId) || this.now() - at >= this.silentMs) on = false;
    }
    if (on || this.state.has(chatId)) this.state.patch(chatId, { runningElsewhere: on });
    if (!this.checkCurrent(chatId, check)) return false;
    if (on) {
      // still going when the writer goes quiet: look again then
      const t = clock.setTimeout(
        () => this.checkCurrent(chatId, check) && this.reconcile(chatId, file, running, source),
        Math.max(1_000, at + this.silentMs - this.now() + 100),
      );
      t.unref?.();
      this.timers.set(chatId, t);
    } else this.checks.delete(chatId);
    return on;
  }

  /** The chat is no longer followed (off screen, or Sage took it over). */
  forget(chatId, source) {
    const check = this.checks.get(chatId);
    if (source && (check?.source ? !matchesSource(check.source, source) : !this.sourceCurrent(chatId, source))) return;
    this.checks.delete(chatId);
    clock.clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
    if (this.state.has(chatId)) this.state.patch(chatId, { runningElsewhere: false });
  }
}

module.exports = { ExternalWrites, codexUnfinished, claudeTailRunning, tailLines, localTurnRunning, SILENT_MS };
