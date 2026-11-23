// What a Codex chat runs after its turn, as main reads it for every window: the commands its thread left running in the background and its sub-agents' running turns.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { methodMissing } = require('./versions.cjs');

/** How often a thread with a background command running is read again, as a window polls an open chat (src/store/codexTasks.ts). */
const POLL_MS = 3000;
/** A list read that doesn't answer in time leaves the count as it was; the next tick reads again. */
const READ_MS = 10_000;

/**
 * Codex runs a chat's background terminals and sub-agents in main's app-server, and says nothing when one starts or
 * ends: a window learned of them only by polling the chat it had open, so a new or reloaded window, or one that never
 * opened the chat, showed it idle. Main keeps the count instead, as it keeps Claude Code's tasks (session.tasks):
 * a thread's terminals are read when its turn ends (what that turn left running) and every POLL_MS while any run; a
 * sub-agent counts while its thread runs a turn. A read that fails keeps the last count, so no command reads as
 * ended by mistake; the thread unloading (thread/closed) and the app-server exiting end them all.
 */
class CodexBackgroundWork {
  /**
   * @param {object} o
   * @param {(threadId: string, timeoutMs: number) => Promise<any>} o.list thread/backgroundTerminals/list
   * @param {() => Iterable<string>} o.turning the threads running a turn now
   * @param {(threadId: string) => string} o.rootOf the thread at the top of a sub-agent's spawn chain (itself when none)
   * @param {(threadId: string, itemId: string) => boolean} o.ownCommand a command item of the thread's running turn, or of a
   *   turn a Stop is ending (that turn's work, not background)
   * @param {(threadId: string) => boolean} o.shown whether a chat shows the thread's work (its current thread, of a chat main
   *   tracks): only those are read
   * @param {(threadId: string, work: { shells: number, agents: number }) => void} o.publish
   * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
   * @param {number} [o.pollMs]
   */
  constructor({
    list,
    turning,
    rootOf,
    ownCommand,
    shown,
    publish,
    timers = { setInterval: clock.setInterval, clearInterval: clock.clearInterval },
    pollMs = POLL_MS,
  }) {
    this.list = list;
    this.turning = turning;
    this.rootOf = rootOf;
    this.ownCommand = ownCommand;
    this.shown = shown;
    this.publish = publish;
    this.timers = timers;
    this.pollMs = pollMs;
    /** thread -> its background commands as last read, and its read in flight (`again`: a trigger came during it) */
    this.shells = new Map();
    /** threads whose work was published as running: each is published again once it ends */
    this.published = new Set();
    /** the app-server process the reads belong to: an exit retires every read in flight */
    this.gen = 0;
    /** @type {any} */
    this.timer = null;
    /** this app-server has no thread/backgroundTerminals/list (an older Codex): nothing is read until the next one */
    this.unlisted = false;
  }

  /** What a notification changes: a turn ending leaves commands behind, a sub-agent's turn starts or ends, a thread unloads. */
  observe(method, p) {
    const threadId = p?.threadId;
    if (typeof threadId !== 'string') return;
    const root = this.rootOf(threadId);
    if (method === 'thread/closed') {
      // unloaded: its terminals went with it; a sub-agent's link is already gone (codexParents.cjs), so every chat
      // that counted work is counted again
      this.shells.delete(threadId);
      this.sync();
      for (const id of new Set([threadId, ...this.published])) this.changed(id);
      return;
    }
    // a spawn links a sub-agent that may already run a turn: the spawning chat counts it from here
    if (p.item?.type === 'collabAgentToolCall') return this.changed(root);
    if (method !== 'turn/started' && method !== 'turn/completed') return;
    if (root !== threadId) return this.changed(root);
    if (method === 'turn/completed' && this.shown(threadId)) this.read(threadId);
  }

  /** The thread's background commands and running sub-agents now. */
  work(threadId) {
    const agents = [...this.turning()].filter((id) => id !== threadId && this.rootOf(id) === threadId).length;
    return { shells: this.shells.get(threadId)?.count ?? 0, agents };
  }

  /** Publish a thread's work when it runs, or when it ran and has ended. */
  changed(threadId) {
    const work = this.work(threadId);
    const running = work.shells + work.agents > 0;
    if (!running && !this.published.has(threadId)) return;
    if (running) this.published.add(threadId);
    else this.published.delete(threadId);
    this.publish(threadId, work);
  }

  /** Read a thread's background commands; one read at a time, and a trigger during it reads once more after. */
  read(threadId) {
    if (this.unlisted) return;
    let rec = this.shells.get(threadId);
    if (!rec) {
      rec = { count: 0, reading: false, again: false };
      this.shells.set(threadId, rec);
    }
    if (rec.reading) return void (rec.again = true);
    rec.reading = true;
    const gen = this.gen;
    const current = () => this.gen === gen && this.shells.get(threadId) === rec;
    this.list(threadId, READ_MS)
      .then(
        (r) => {
          if (!current()) return;
          const rows = r?.data ?? r?.terminals;
          rec.count = (Array.isArray(rows) ? rows : []).filter(
            (t) => t && t.processId != null && !this.ownCommand(threadId, String(t.itemId ?? '')),
          ).length;
        },
        (error) => {
          // a list that can't be read settles nothing: the count stays, and the next tick asks again
          if (methodMissing(error)) this.unlisted = true;
          else noteIgnored("read a Codex thread's background commands", error);
        },
      )
      .finally(() => {
        if (!current()) return;
        rec.reading = false;
        if (!rec.count && !rec.again) this.shells.delete(threadId);
        this.sync();
        this.changed(threadId);
        if (rec.again) {
          rec.again = false;
          this.read(threadId);
        }
      });
  }

  /**
   * Each POLL_MS: read again every thread with a command running, except one whose read is still out (a slow
   * app-server). A thread no chat shows any more (its chat switched segment) stops being read and takes its count down.
   */
  tick() {
    for (const [id, r] of this.shells) {
      if (!this.shown(id)) {
        this.shells.delete(id);
        this.changed(id);
      } else if (r.count > 0 && !r.reading) this.read(id);
    }
    this.sync();
  }

  /** The timer runs while any thread has a background command running. */
  sync() {
    const any = [...this.shells.values()].some((r) => r.count > 0);
    if (any && !this.timer) {
      this.timer = this.timers.setInterval(() => this.tick(), this.pollMs);
      this.timer?.unref?.();
    } else if (!any && this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The app-server exited: every background command and sub-agent went with it (call after its running turns are cleared). */
  clear() {
    this.gen++;
    this.unlisted = false;
    this.shells.clear();
    this.sync();
    for (const id of [...this.published]) this.changed(id);
  }
}

module.exports = { CodexBackgroundWork, POLL_MS };
