// Automatically archive inactive chats (Settings → General, #1367): a sweep in main, with or without a window, archives
// a chat no one has used for the chosen number of days, on every harness, unless something still holds it.
const { clock } = require('../platform/ports/clock.cjs');
const { firstSegment, toRendererSegment, nativeIdsOf } = require('../platform/chats.cjs');
const { segmentAliases } = require('../../shared/segmentAlias.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { goalHolds } = require('./goalStatus.cjs');

const DAY_MS = 86_400_000;
/** The first sweep waits for startup to settle; then one an hour; a changed setting sweeps soon after. */
const FIRST_SWEEP_MS = 60_000;
const SWEEP_MS = 3_600_000;
const SETTING_SWEEP_MS = 2_000;

/** A segment's key as its listing names it: a chat's own id for its first segment ('claude:<id>', a bare Codex id, 'acp:<harness>:<id>'). */
const segmentKey = (s) => toRendererSegment(s).nativeId;

/**
 * @typedef {{ key: string, at: number }} Activity a native session and when it last changed (ms)
 * @typedef {object} AutoArchiveDeps
 * @property {any} chats the chat store (electron/platform/chats.cjs)
 * @property {any} state the session store (electron/session/state.cjs)
 * @property {(s: any) => boolean} busy whether a session's turn is running or waiting on the user
 * @property {() => number | null} days the setting
 * @property {Record<string, () => Promise<Activity[]>>} sources each harness's sessions; a source that throws leaves its chats unknown
 * @property {() => Promise<Iterable<string>>} scheduled the chats scheduled tasks run in
 * @property {(chatId: string) => string[]} children the chats a chat started (linked sessions)
 * @property {(chatId: string) => Promise<unknown> | null} archiveNative a harness's own archive kept in step, or null
 * @property {(chatId: string, view: any) => void} broadcast every window hears of the change
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(t: any) => void} [clearTimer]
 */

class AutoArchive {
  /** @param {AutoArchiveDeps} o */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? (() => clock.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => clock.setTimeout(fn, ms).unref());
    this.clearTimer = o.clearTimer ?? clock.clearTimeout;
    this.timer = null;
    /** @type {Promise<string[]> | null} */
    this.running = null;
    this.again = false;
    this.days = o.days();
  }

  start() {
    this.schedule(FIRST_SWEEP_MS);
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Settings changed: a new number of days sweeps soon (other settings, and Never, sweep nothing new). */
  settingsChanged() {
    const days = this.o.days();
    if (days === this.days) return;
    this.days = days;
    if (days !== null) this.schedule(SETTING_SWEEP_MS);
  }

  schedule(ms) {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.sweep()
        .catch((error) => noteIgnored('archive inactive chats', error))
        .finally(() => {
          if (!this.timer) this.schedule(SWEEP_MS);
        });
    }, ms);
  }

  /** One sweep at a time; asked during one, it runs once more after it. Resolves to the chats it archived. */
  sweep() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const archived = [];
      do {
        this.again = false;
        archived.push(...(await this.run()));
      } while (this.again);
      return archived;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async run() {
    this.days = this.o.days();
    if (this.days === null) return [];
    // what each session looked like before listing: one that changes meanwhile (a turn that started, even one that ended
    // already) was used after its listed time, and is left for the next sweep
    const { state } = this.o;
    const revs = new Map(state.all().map((id) => [id, state.get(id).rev]));
    const seen = new Map();
    for (const [family, list] of Object.entries(this.o.sources)) {
      try {
        for (const { key, at } of await list()) if (Number.isFinite(at)) seen.set(key, Math.max(seen.get(key) ?? 0, at));
      } catch (error) {
        // its chats' activity is unknown this time, so none of them is archived
        noteIgnored(`list ${family} chats to archive inactive ones`, error);
      }
    }
    const scheduled = new Set(await this.o.scheduled());
    const archived = [];
    for (const chatId of this.candidates(seen.keys())) {
      // the setting (settingsChanged keeps it current) and every hold are read again right before the write: a send or a
      // change meanwhile wins
      if (this.days === null) break;
      if (!this.inactive(chatId, seen, scheduled, revs, this.now() - this.days * DAY_MS)) continue;
      if (!this.archive(chatId)) continue;
      archived.push(chatId);
      // let other work in between chats
      await new Promise((resolve) => setImmediate(resolve));
    }
    return archived;
  }

  /** Each chat once: a listed session another chat switched to belongs to that chat. */
  *candidates(keys) {
    const { records } = this.o.chats;
    const owners = segmentAliases(nativeIdsOf(records));
    const done = new Set();
    for (const key of [...keys, ...records.keys()]) {
      const chatId = owners.get(key) ?? key;
      if (done.has(chatId)) continue;
      done.add(chatId);
      yield chatId;
    }
  }

  /** When the chat was last used, or null when any of its sessions is unknown. */
  lastActive(chatId, seen) {
    const rec = this.o.chats.records.get(chatId);
    let last = typeof rec?.meta?.activeAt === 'number' ? rec.meta.activeAt : 0;
    for (const s of rec?.segments ?? [firstSegment(chatId)]) {
      const at = seen.get(segmentKey(s));
      if (at === undefined) return null;
      last = Math.max(last, at);
    }
    return last;
  }

  /** Inactive since before `cutoff`, and nothing holds it: pinned, working, waiting, scheduled, MoMo's or with working sessions. */
  inactive(chatId, seen, scheduled, revs, cutoff) {
    const { chats, state, busy, children } = this.o;
    if (chats.isDeleted(chatId) || chats.newer.has(chatId) || chats.unreadable.has(chatId)) return false;
    const meta = chats.records.get(chatId)?.meta;
    // MoMo's main chat is long-lived: archiving it would start MoMo over (electron/momo/mainChat.cjs)
    if (meta?.archived != null || meta?.pinned || meta?.goalHeld != null || isMomoMeta(meta) || scheduled.has(chatId)) return false;
    const held = (id) => {
      // a running goal holds the chat with no window open, before its session is loaded (#2759)
      if (goalHolds(state.goalStatus(id))) return true;
      if (!state.has(id)) return false;
      const s = state.get(id);
      return s.rev !== revs.get(id) || busy(s) || s.queue.length > 0 || s.approvals.length > 0 || !!s.pendingSwitch;
    };
    if (held(chatId) || children(chatId).some(held)) return false;
    const last = this.lastActive(chatId, seen);
    return last !== null && last < cutoff;
  }

  archive(chatId) {
    const { chats } = this.o;
    // patchMeta-changes: false means the chat is skipped, not an error
    if (!chats.patchMeta(chatId, { archived: this.now() })) return false;
    this.o.broadcast(chatId, chats.get(chatId));
    // the harness's own archive is kept in step, best effort, as a manual archive does; a failure there, even a thrown
    // one, leaves the chat archived in MoPilot and the sweep going
    Promise.resolve()
      .then(() => this.o.archiveNative(chatId))
      .catch((error) => noteIgnored('archive an inactive chat in its harness too', error));
    return true;
  }
}

module.exports = { AutoArchive, DAY_MS, FIRST_SWEEP_MS, SWEEP_MS, SETTING_SWEEP_MS };
