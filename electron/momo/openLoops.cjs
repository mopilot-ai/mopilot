// MoMo's open loops (#2139 P4, L4): promises, dates and to-dos the user said in a MoMo main chat, each with its quote, confidence and due time, sealed in <momo dir>/open-loops.json (sealedFile.cjs: encrypted, one change at a time, across MoPilots by the lock) and deleted by Reset with the memory. A memory pass adds, renews and closes them (memoryPass.cjs, checked by openLoopsShape.cjs); the user closes, dismisses or snoozes them; nudges record what fired (P4b). At most MAX_OPEN open: past it the oldest `likely` ones go first, and a `sure` one is never dropped to make room (the new loop is refused and counted instead). Closed loops are kept 90 days for "why", then pruned.
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { isLoop, norm } = require('./openLoopsShape.cjs');

const FILE = 'open-loops.json';
/** The most open loops kept. */
const MAX_OPEN = 500;
/** How long a closed loop is kept. */
const CLOSED_KEEP_MS = 90 * 86_400_000;
/** The most nudges remembered per loop. */
const NUDGES_KEPT = 20;

/** @typedef {import('./openLoopsShape.cjs').OpenLoop} OpenLoop */

/** The kept loops: the valid ones, closed ones past CLOSED_KEEP_MS pruned. */
const shapeOf = (/** @type {unknown} */ v, /** @type {number} */ now) => {
  const loops = Array.isArray(/** @type {any} */ (v)?.loops) ? /** @type {any} */ (v).loops : [];
  return {
    loops: /** @type {OpenLoop[]} */ (
      loops.filter((/** @type {unknown} */ l) => isLoop(l) && !(l.state !== 'open' && (l.closedAt ?? 0) < now - CLOSED_KEEP_MS))
    ),
  };
};

/** A loop error the IPC and tool layers pass on by its code. */
class LoopError extends Error {
  /** @param {string} message @param {'not_found' | 'bad_args'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Emits 'changed' after every write. */
class OpenLoopStore extends EventEmitter {
  /** @param {{ dir: string, safeStorage: any, now?: () => number, newId?: () => string }} o */
  constructor({ dir, safeStorage, now = Date.now, newId = () => crypto.randomUUID() }) {
    super();
    this.now = now;
    this.newId = newId;
    this.file = new SealedJson({ file: path.join(dir, FILE), safeStorage, now, shape: shapeOf });
  }

  /** Every kept loop, newest said first; throws when the file can't be read now. @returns {OpenLoop[]} */
  list() {
    return [...this.file.read().loops].sort((a, b) => b.saidAt - a.saidAt);
  }

  /** The open loops (snoozed ones included). */
  open() {
    return this.list().filter((l) => l.state === 'open');
  }

  /** @template R @param {(loops: OpenLoop[]) => R} fn */
  async #change(fn) {
    const out = await this.file.change((v) => fn(v.loops));
    this.emit('changed');
    return out;
  }

  /**
   * A pass's checked loop ops (openLoopsShape.cjs checkLoops), from `source`: a loop already kept with the same quote or
   * text from that chat is renewed instead of added again, and one the user closed is never reopened. Returns how many
   * were added, renewed, closed, and refused because MAX_OPEN `sure` loops are open.
   * @param {{ add: any[], mention: string[], done: string[] }} ops
   * @param {{ chatId: string, harness: string }} source
   */
  applyPass(ops, source) {
    const at = this.now();
    return this.#change((loops) => {
      let added = 0;
      let renewed = 0;
      let closed = 0;
      let refused = 0;
      const byId = new Map(loops.map((l) => [l.id, l]));
      for (const id of ops.mention) {
        const l = byId.get(id);
        if (l?.state === 'open') {
          l.lastMentionedAt = at;
          renewed++;
        }
      }
      for (const id of ops.done) {
        const l = byId.get(id);
        if (l?.state === 'open') {
          l.state = 'done';
          l.closedAt = at;
          closed++;
        }
      }
      for (const a of ops.add) {
        const same = loops.find(
          (l) => l.source.chatId === source.chatId && (norm(l.quote) === norm(a.quote) || norm(l.text) === norm(a.text)),
        );
        if (same) {
          if (same.state === 'open') {
            same.lastMentionedAt = at;
            renewed++;
          }
          continue;
        }
        if (!makeRoom(loops)) {
          refused++;
          continue;
        }
        loops.push({
          id: this.newId(),
          kind: a.kind,
          text: a.text,
          quote: a.quote,
          source: { chatId: source.chatId, harness: source.harness, turnId: a.line.turnId },
          saidAt: a.line.at,
          tz: a.tz,
          confidence: a.confidence,
          ...(a.dueAt !== undefined ? { dueAt: a.dueAt } : {}),
          ...(a.dueDay ? { dueDay: a.dueDay } : {}),
          ...(a.event ? { event: a.event } : {}),
          lastMentionedAt: at,
          state: 'open',
          nudged: [],
        });
        added++;
      }
      return { added, renewed, closed, refused };
    });
  }

  /**
   * The user (or a nudge's answer) closes, dismisses or reopens a loop.
   * @param {string} id @param {'done' | 'dismissed' | 'open'} state
   */
  async setState(id, state) {
    if (!['done', 'dismissed', 'open'].includes(state)) throw new LoopError('state is done, dismissed or open', 'bad_args');
    const at = this.now();
    return this.#change((loops) => {
      const l = find(loops, id);
      l.state = state;
      if (state === 'open') {
        delete l.closedAt;
        l.lastMentionedAt = at;
      } else l.closedAt = at;
      return { ...l };
    });
  }

  /** No nudge for `id` before `until` (null: wake it now). */
  async snooze(/** @type {string} */ id, /** @type {number | null} */ until) {
    if (until !== null && !(typeof until === 'number' && Number.isFinite(until)))
      throw new LoopError('until is a time in milliseconds', 'bad_args');
    return this.#change((loops) => {
      const l = find(loops, id);
      if (until === null || until <= this.now()) delete l.snoozedUntil;
      else l.snoozedUntil = until;
      return { ...l };
    });
  }

  /** A nudge for `id` fired (P4b): `askedClose` when it was the one that asks whether to close it. */
  nudged(/** @type {string} */ id, /** @type {{ at: number, trigger: string, key: string, askedClose?: boolean }} */ n) {
    return this.#change((loops) => {
      const l = find(loops, id);
      l.nudged = [...l.nudged, { at: n.at, trigger: n.trigger, key: n.key }].slice(-NUDGES_KEPT);
      if (n.askedClose) l.askedClose = n.at;
      return { ...l };
    });
  }

  /** Reset: the file and its set-aside copies go, and no change asked for before lands. */
  erase() {
    return this.file.erase();
  }

  /** Every change queued so far has settled. */
  idle() {
    return this.file.queue;
  }
}

/** The loop `id` in `loops`, or not_found. */
function find(/** @type {OpenLoop[]} */ loops, /** @type {string} */ id) {
  const l = loops.find((x) => x.id === id);
  if (!l) throw new LoopError('No such open loop', 'not_found');
  return l;
}

/**
 * Room for one more open loop: at MAX_OPEN the oldest `likely` open one is dropped; false when every open
 * loop is `sure` (none is dropped to make room).
 */
function makeRoom(/** @type {OpenLoop[]} */ loops) {
  const open = loops.filter((l) => l.state === 'open');
  if (open.length < MAX_OPEN) return true;
  const oldest = open.filter((l) => l.confidence === 'likely').sort((a, b) => a.saidAt - b.saidAt)[0];
  const at = oldest ? loops.indexOf(oldest) : -1;
  if (at < 0) return false;
  loops.splice(at, 1);
  return true;
}

module.exports = { OpenLoopStore, LoopError, FILE, MAX_OPEN, CLOSED_KEEP_MS, NUDGES_KEPT, shapeOf, makeRoom };
