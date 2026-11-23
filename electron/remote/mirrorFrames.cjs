// Remote frames: low-rate JPEGs of the in-app browser page or the computer-use screen, taken only while a tool runs for a chat a device follows, through the same masked capture the model's screenshots use.
const { assertMirror, stillAllowed } = require('./mirrorGuard.cjs');

/** At most 2 frames a second. */
const FRAME_MS = 500;
/** A sealed message is at most 256 KB; a frame over this much is skipped rather than split. */
const MAX_FRAME_CHARS = 180_000;

class FrameMirror {
  /** @param {any} svc the RemoteService */
  constructor(svc) {
    this.svc = svc;
    /** @type {Map<string, Map<string, any>>} chat -> pair -> client */
    this.subs = new Map();
    /** @type {Map<string, { gen: number, timer: any, busy: boolean, seq: number }>} chat -> its running loop */
    this.loops = new Map();
    this.off = null;
  }

  get #m() {
    return this.svc.ops.mirror;
  }

  subscribe(/** @type {any} */ client, /** @type {{ chatId: string }} */ { chatId }) {
    assertMirror(this.svc, client, chatId);
    const pairs = this.subs.get(chatId) ?? new Map();
    pairs.set(client.pairId, client);
    this.subs.set(chatId, pairs);
    // the tool starting or ending is told by the host; one listener serves every chat
    this.off ??= this.#m.tool.onChange((/** @type {string} */ id) => this.#sync(id));
    this.#sync(chatId);
    return { subscribed: true, active: this.loops.has(chatId) };
  }

  unsubscribe(/** @type {any} */ client, /** @type {{ chatId: string }} */ { chatId }) {
    this.subs.get(chatId)?.delete(client.pairId);
    this.#sync(chatId);
    return { unsubscribed: true };
  }

  /** Starts the chat's loop when a subscriber and a running tool both exist, stops it when either goes. */
  #sync(/** @type {string} */ chatId) {
    this.#prune(chatId);
    const wanted = (this.subs.get(chatId)?.size ?? 0) > 0 && this.#m.tool.running(chatId) !== null;
    const loop = this.loops.get(chatId);
    if (wanted && !loop) {
      const l = { gen: 0, timer: null, busy: false, seq: 0 };
      this.loops.set(chatId, l);
      this.#announce(chatId, true);
      void this.#tick(chatId, l);
    } else if (!wanted && loop) this.#stop(chatId, loop);
  }

  #prune(/** @type {string} */ chatId) {
    const pairs = this.subs.get(chatId);
    for (const [pairId, client] of pairs ?? []) if (!stillAllowed(this.svc, client, chatId)) pairs?.delete(pairId);
    if (pairs && !pairs.size) this.subs.delete(chatId);
  }

  #stop(/** @type {string} */ chatId, /** @type {any} */ loop) {
    loop.gen++;
    this.#timers.clearTimeout(loop.timer);
    this.loops.delete(chatId);
    this.#announce(chatId, false);
  }

  get #timers() {
    return this.#m.timers ?? { setTimeout, clearTimeout };
  }

  #announce(/** @type {string} */ chatId, /** @type {boolean} */ active) {
    for (const client of this.subs.get(chatId)?.values() ?? [])
      void this.svc
        .emit(client.pairId, { ev: 'frames.state', chatId, active })
        .catch((e) => this.svc.note('tell a phone frames started or stopped', e));
  }

  async #tick(/** @type {string} */ chatId, /** @type {any} */ loop) {
    const started = this.svc.now();
    const gen = loop.gen;
    this.#prune(chatId);
    const surface = this.#m.tool.running(chatId);
    if (!surface || !this.subs.has(chatId)) return this.#sync(chatId);
    try {
      const shot = await this.#m.frame(chatId, surface);
      // the tool may have ended, or the last device left, while the image was taken: that frame is not sent
      if (loop.gen === gen && shot && this.#m.tool.running(chatId) === surface && this.subs.has(chatId))
        this.#send(chatId, loop, surface, shot);
    } catch (error) {
      this.svc.note('take a frame for a paired phone', error);
    }
    if (loop.gen !== gen) return;
    loop.timer = this.#timers.setTimeout(() => void this.#tick(chatId, loop), Math.max(0, FRAME_MS - (this.svc.now() - started)));
  }

  #send(/** @type {string} */ chatId, /** @type {any} */ loop, /** @type {string} */ surface, /** @type {any} */ shot) {
    if (typeof shot.data !== 'string' || shot.data.length > MAX_FRAME_CHARS)
      return this.svc.note('send a frame to a paired phone', new Error('frame too large'));
    const event = { ev: 'frames.frame', chatId, surface, seq: ++loop.seq, width: shot.width, height: shot.height, jpeg: shot.data };
    for (const client of /** @type {Map<string, any>} */ (this.subs.get(chatId)).values())
      void this.svc.emit(client.pairId, event).catch((e) => this.svc.note('send a frame to a paired phone', e));
  }

  /** The switch or a follow changed: devices that may no longer watch the chat are dropped, and a loop with nobody stops. */
  recheck() {
    for (const chatId of [...this.subs.keys()]) this.#sync(chatId);
  }

  dropPair(/** @type {string} */ pairId) {
    for (const [chatId, pairs] of [...this.subs]) {
      if (pairs.delete(pairId)) this.#sync(chatId);
    }
  }

  closeAll() {
    this.subs.clear();
    for (const [chatId, loop] of [...this.loops]) this.#stop(chatId, loop);
    this.off?.();
    this.off = null;
  }
}

module.exports = { FrameMirror, FRAME_MS, MAX_FRAME_CHARS };
