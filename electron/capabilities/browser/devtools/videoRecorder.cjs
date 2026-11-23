// browser_record: a video (.mov, Motion JPEG) of one tab a chat's agent works on, from the tab's CDP screencast, written to the chat's upload folder as it records.
//
// Frames follow the GIF recorder's rule (gifRecorder.cjs): a page of a high-risk site, one with credentials in its address,
// a page with a password field (screencast frames can't be masked as screenshots are, so they are left out) and a tab the
// user signs in on or took over are never recorded. A tool call on the tab (hostPageGates.cjs touch) re-reads whether its
// page has a password field and restarts the screencast after the debugger let go (each turn end detaches it).
// A recording ends on stop, on its caps (MAX_MS, MAX_BYTES), or when the chat's turn ends: what was recorded is saved
// either way, and the next browser_record call says where.
const { noteIgnored } = require('../../../ignored.cjs');
const { PROBE_MS, credentialFieldIn } = require('../credentialProbe.cjs');
const { MovWriter } = require('./movWriter.cjs');
const lease = require('../screencastLease.cjs');

const WIDTH = 1280;
/** At most one frame per GAP_MS (about 15 frames a second); a burst keeps its first. */
const GAP_MS = 66;
const MAX_MS = 10 * 60_000;
const MAX_BYTES = 512 * 1024 * 1024;
const SCREENCAST = { format: 'jpeg', quality: 70, maxWidth: WIDTH, maxHeight: WIDTH * 2, everyNthFrame: 1 };

/**
 * @typedef {{ tab: any, writer: InstanceType<typeof MovWriter>, started: number, last: number, skipped: number,
 *             listener: ((e: any, method: string, p: any, sessionId?: string) => void) | null, detached: (() => void) | null,
 *             dbg: any, why: string | null }} Recording
 */

class VideoRecorder {
  /**
   * @param {{ images?: { fromBuffer: (buf: Buffer) => any } | null, riskOf?: (url: string) => { level: string, credentials?: boolean },
   *           now?: () => number, gapMs?: number, maxMs?: number, maxBytes?: number, follow?: boolean }} o
   *   follow: a tool call on another tab of a recorded chat moves the recording to that tab (the turn trace follows the agent)
   */
  constructor({
    images = null,
    riskOf = () => ({ level: 'normal' }),
    now = Date.now,
    gapMs = GAP_MS,
    maxMs = MAX_MS,
    maxBytes = MAX_BYTES,
    follow = false,
  }) {
    this.follow = follow;
    this.images = images;
    this.riskOf = riskOf;
    this.now = now;
    this.gapMs = gapMs;
    this.maxMs = maxMs;
    this.maxBytes = maxBytes;
    /** @type {Map<string, Recording>} chat -> its recording */
    this.chats = new Map();
    /** chat -> what the last recording that ended on its own saved (told by the next call) */
    this.ended = new Map();
    /** tab -> whether its page had a password field at its last tool call */
    this.passwords = new WeakMap();
  }

  /**
   * Starts recording `tab` into `file` (or into `writer`, anything with MovWriter's add, finish, width and bytes); a
   * recording the chat had is finished first and returned.
   */
  async start(/** @type {string} */ chatId, tab, /** @type {string} */ file, /** @type {any} */ writer = null) {
    const before = this.stop(chatId);
    /** @type {Recording} */
    const rec = {
      tab,
      writer: writer ?? new MovWriter(file),
      started: this.now(),
      last: 0,
      skipped: 0,
      listener: null,
      detached: null,
      dbg: null,
      why: null,
    };
    this.chats.set(chatId, rec);
    await this.touch(tab);
    return before;
  }

  /** Finishes the chat's recording; returns what it saved (null when nothing was recording or no frame was kept). */
  stop(/** @type {string} */ chatId, why = /** @type {string | null} */ (null)) {
    const rec = this.chats.get(chatId);
    if (!rec) return null;
    this.chats.delete(chatId);
    this.#uncast(rec);
    const out = rec.writer.finish();
    return { saved: out, skipped: rec.skipped, why: why ?? rec.why };
  }

  /** The chat's turn ended: its recording is finished and kept for the next call to tell. */
  endTurn(/** @type {string} */ chatId) {
    const r = this.stop(chatId, 'the turn ended');
    if (r) this.ended.set(chatId, r);
  }

  /** What the chat's last recording saved when it ended on its own, once. */
  takeEnded(/** @type {string} */ chatId) {
    const r = this.ended.get(chatId) ?? null;
    this.ended.delete(chatId);
    return r;
  }

  /** A tool call on `tab`: while it is recorded, re-reads its password fields and (re)starts its screencast. Never throws. */
  async touch(tab) {
    const rec = this.follow ? this.chats.get(tab.chatId) : [...this.chats.values()].find((r) => r.tab === tab);
    if (!rec) return;
    if (rec.tab !== tab) {
      // the agent moved to another tab of the chat: its frames from now on
      this.#uncast(rec);
      rec.tab = tab;
    }
    try {
      this.passwords.set(tab, await credentialFieldIn(tab, { ms: PROBE_MS, unreadable: true }));
      this.#cast(rec);
    } catch (error) {
      noteIgnored('restart the screencast of a recorded tab', error);
    }
  }

  #allowed(tab) {
    const risk = tab.url ? this.riskOf(tab.url) : null;
    return !tab.signin && !tab.takenOver && !this.passwords.get(tab) && !!risk && risk.level === 'normal' && !risk.credentials;
  }

  /** A screencast frame of the recorded tab. */
  frame(/** @type {Recording} */ rec, /** @type {Buffer} */ jpeg) {
    const at = this.now();
    if (at - rec.started > this.maxMs) return void this.#capped(rec, 'it reached 10 minutes');
    if (!this.#allowed(rec.tab)) return void rec.skipped++;
    if (rec.last && at - rec.last < this.gapMs) return;
    const fit = this.#fit(rec, jpeg);
    if (!fit || !rec.writer.add(fit, at)) return void rec.skipped++;
    rec.last = at;
    if (rec.writer.bytes > this.maxBytes) this.#capped(rec, 'it reached 512 MB');
  }

  /** The frame at the recording's first frame's width (the tab was resized, or it is wider). */
  #fit(/** @type {Recording} */ rec, /** @type {Buffer} */ jpeg) {
    const width = rec.writer.width;
    if (!width || !this.images) return jpeg;
    try {
      const img = this.images.fromBuffer(jpeg);
      return img.getSize().width === width ? jpeg : img.resize({ width }).toJPEG(70);
    } catch (error) {
      noteIgnored('fit a recorded frame to the video', error);
      return null;
    }
  }

  #capped(/** @type {Recording} */ rec, /** @type {string} */ why) {
    const chatId = [...this.chats].find(([, r]) => r === rec)?.[0];
    rec.why = why;
    if (chatId) this.ended.set(chatId, /** @type {any} */ (this.stop(chatId)));
  }

  /** The tab's screencast, once per CDP session, shared with the tab's other recorders (screencastLease.cjs; it ends when the debugger detaches; the next touch starts it again). */
  #cast(/** @type {Recording} */ rec) {
    const dbg = rec.tab.backend?.debugger;
    if (typeof dbg?.on !== 'function') return;
    if (rec.dbg !== dbg) {
      this.#uncast(rec);
      rec.dbg = dbg;
      rec.listener = (_e, method, p, sessionId) => {
        if (method !== 'Page.screencastFrame' || sessionId) return;
        rec.tab
          .send('Page.screencastFrameAck', { sessionId: p.sessionId })
          .catch((error) => noteIgnored('acknowledge a screencast frame', error));
        if (this.chats.get(rec.tab.chatId) === rec) this.frame(rec, Buffer.from(p.data, 'base64'));
      };
      rec.detached = () => lease.detached(rec.tab);
      dbg.on('message', rec.listener);
      dbg.on('detach', rec.detached);
    }
    lease.acquire(rec.tab, rec, SCREENCAST);
  }

  #uncast(/** @type {Recording} */ rec) {
    if (rec.dbg) {
      rec.dbg.removeListener?.('message', rec.listener);
      rec.dbg.removeListener?.('detach', rec.detached);
    }
    lease.release(rec.tab, rec);
    rec.dbg = null;
    rec.listener = null;
    rec.detached = null;
  }
}

module.exports = { VideoRecorder, WIDTH, GAP_MS, MAX_MS, MAX_BYTES };
