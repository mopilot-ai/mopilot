// What the Mac's channel does when a phone's session fails locally (a full receive queue, a failed save) instead of ending it: the session is paused, frames that arrive are held unacknowledged, and the relay is asked (with a wait that doubles while pauses keep coming) to send again what it never saw acknowledged; a new relay connection brings the session back. Also the counters of what the channel has seen, and the notice a phone gets when its counters are ahead.
const { fromHex, MAX_SKIP } = require('./esm.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** Reasons a session pauses and comes back; any other `closed` reason (a removed pair) is final. */
const PAUSES = new Set(['overload', 'storage']);
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** Pauses this far apart are not one run. */
const QUIET_MS = 60_000;
/** A phone is told about a gap in its counters at most this often per pair. */
const NOTICE_EVERY_MS = 60_000;
/** The sealed event a phone gets when its counters no longer line up with the Mac's. */
const RESYNC_EVENT = 'pair.resync';

/**
 * Reading a frame costs one hash step per counter it skips, and the walk happens before the tag is checked, so a sender of frames with far
 * counters could make the Mac do thousands of steps per frame. A session may spend this many steps in a burst and earns them back at the
 * refill rate; a frame it cannot afford yet waits its turn (frames are read in order, none is read past or lost), so forged frames slow a
 * pair down but never end or pause it. A frame in order, or one refused before any walk (replay, rewind, or beyond MAX_SKIP), costs one step.
 */
const BUDGET_STEPS = 8_192;
/** The steps of a catch-up walk done before the event loop is given back (a chunk of about 25 ms), and the spacing of its cached chain points. */
const CATCH_UP_CHUNK = 1_024;
const REFILL_STEPS_PER_SECOND = 1_000;

/** The steps reading a frame `ahead` counters past the receiver's takes. @param {number} ahead */
const walkSteps = (ahead) => (ahead > 1 && ahead <= MAX_SKIP ? ahead : 1);

/** The counts kept for each phone, shown with its entry in the Mobile Remote status. */
const newCounts = () => ({ dropped: 0, duplicates: 0, gaps: 0, held: 0, throttled: 0 });

/** Whether a session ended for good (a paused one has not). @param {{ closed: string | null }} s */
const ended = (s) => !!s.closed && !PAUSES.has(s.closed);
/** Whether a session is paused. @param {{ closed: string | null }} s */
const paused = (s) => !!s.closed && PAUSES.has(s.closed);

class SessionPauses {
  /**
   * @param {object} o
   * @param {() => Iterable<any>} o.sessions the channel's sessions
   * @param {any} o.relay a RelayClient (reconnect)
   * @param {any} o.devices the device list (the saved receive counters)
   * @param {any} o.crypto createCrypto's result (createReceiver)
   * @param {() => number} o.now
   * @param {() => number} [o.mono] a clock that never goes back, for the budget (a wall clock that is set back must not empty it)
   * @param {{ steps: number, perSecond: number }} [o.budget]
   * @param {number} [o.reconnectMs] the first wait before the relay is asked again
   * @param {(pairId: string, notice: object) => Promise<void>} o.notify seals a notice for the phone
   */
  constructor(o) {
    this.o = o;
    this.mono = o.mono ?? (() => performance.now());
    this.limit = o.budget ?? { steps: BUDGET_STEPS, perSecond: REFILL_STEPS_PER_SECOND };
    /** Wake-ups of the frames waiting for budget, so a stopped channel leaves no timer. @type {Set<() => void>} */
    this.sleepers = new Set();
    this.gaps = 0;
    this.held = 0;
    this.throttled = 0;
    this.reopens = 0;
    this.reconnects = 0;
    this.pauses = { overload: 0, storage: 0 };
    /** Pauses without a quiet minute between them: the wait before asking the relay doubles with it. */
    this.streak = 0;
    this.lastPauseAt = -Infinity;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    /** @type {Set<(e: { pairId: string, code: string }) => void>} */
    this.closed = new Set();
    /** @type {Set<(e: { pairId: string, code: string }) => void>} */
    this.reopened = new Set();
  }

  /** @param {Set<(e: { pairId: string, code: string }) => void>} listeners @param {string} pairId @param {string} code */
  tell(listeners, pairId, code) {
    for (const fn of [...listeners]) {
      try {
        fn({ pairId, code });
      } catch (error) {
        noteIgnored('tell a close listener', error);
      }
    }
  }

  /**
   * Counts a frame the session did not read or could not open. @param {{ counts?: Record<string, number> } | undefined} s
   * @param {'dropped' | 'duplicates' | 'gaps' | 'held' | 'throttled'} key
   */
  count(s, key) {
    if (s?.counts) s.counts[key]++;
    if (key === 'gaps' || key === 'held' || key === 'throttled') this[key]++;
  }

  /** A full budget for a session that starts now. */
  freshBudget() {
    return { budget: this.limit.steps, budgetAt: this.mono() };
  }

  /** Whether `cost` steps fit what the session may spend now; spends them if so. @param {any} s @param {number} cost */
  afford(s, cost) {
    const at = this.mono();
    const earned = Math.max(0, at - s.budgetAt) / 1000;
    s.budget = Math.min(this.limit.steps, s.budget + earned * this.limit.perSecond);
    s.budgetAt = at;
    if (cost > s.budget) return false;
    s.budget -= cost;
    return true;
  }

  /**
   * Pays for reading a frame `ahead` counters past the receiver's, waiting for the budget to refill if it must. False when the session is gone
   * or ended while it waited: the frame is then left unacknowledged, for the relay to send again.
   * @param {any} s @param {number} ahead
   */
  async buy(s, ahead) {
    return this.pay(s, Math.min(walkSteps(ahead), this.limit.steps));
  }

  /**
   * Pays `cost` steps (at most the budget's size), waiting for the refill; false when the session is gone or ended meanwhile.
   * @param {any} s @param {number} cost
   */
  async pay(s, cost) {
    let waited = false;
    while (!this.afford(s, cost)) {
      if (!waited) this.count(s, 'throttled');
      waited = true;
      await this.sleep(Math.ceil(((cost - s.budget) / this.limit.perSecond) * 1000));
      if (ended(s) || ![...this.o.sessions()].includes(s)) return false;
    }
    return true;
  }

  /** @param {number} ms */
  sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve(undefined);
      };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      this.sleepers.add(wake);
    });
  }

  /**
   * The session pauses. A failed save puts the counters back, so the relay is asked at once; a full queue keeps its frames (they come first), so
   * the relay is asked when they have been read (`drained`).
   * @param {any} s @param {'overload' | 'storage'} code
   */
  pause(s, code) {
    // pauses that keep coming within a minute wait longer each time; a quiet minute starts the wait over
    const at = this.o.now();
    if (at - this.lastPauseAt > QUIET_MS) this.streak = 0;
    this.lastPauseAt = at;
    s.closed = code;
    this.pauses[code]++;
    this.tell(this.closed, s.device.pairId, code);
    // a failed save: the counters go back to what was saved at once, so no frame is read from a state the disk never had
    if (code === 'storage') {
      const saved = this.o.devices.get(s.device.id);
      if (saved)
        s.rx = this.o.crypto.createReceiver({ pair: s.device.pairId, dir: 'p2m', chain: fromHex(saved.rx.chain), ctr: saved.rx.ctr });
    }
    if (code === 'storage' || !s.receivingActive) this.askRelayAgain();
  }

  /** The queue that filled up has been read: the frames refused meanwhile are asked for again. @param {any} s */
  drained(s) {
    if (s.closed === 'overload') this.askRelayAgain();
  }

  /** Reconnects to the relay after a wait that doubles while pauses keep coming; it stops when no session is paused. */
  askRelayAgain() {
    if (this.timer) return;
    const tick = () => {
      this.timer = null;
      if (![...this.o.sessions()].some(paused)) return;
      this.reconnects++;
      // if the new connection does not bring them back, ask again later; the timer is set first, because a relay that connects at once
      // reopens the sessions (and stops the asking) from inside reconnect()
      this.streak++;
      this.timer = setTimeout(tick, this.wait());
      this.timer.unref?.();
      this.o.relay.reconnect?.();
    };
    this.timer = setTimeout(tick, this.wait());
    this.timer.unref?.();
  }

  wait() {
    return Math.min(RECONNECT_MAX_MS, (this.o.reconnectMs ?? RECONNECT_BASE_MS) * 2 ** this.streak);
  }

  /** The relay connected again: paused sessions read from what was saved, so the frames it sends again are read in order. */
  reopenAll() {
    for (const s of this.o.sessions()) {
      const code = s.closed;
      if (!code || !PAUSES.has(code)) continue;
      s.closed = null;
      this.reopens++;
      this.tell(this.reopened, s.device.pairId, code);
    }
    this.stop();
  }

  /** Tells a phone its counters are ahead of what the Mac has, at most once a minute per pair. @param {any} s */
  noticeGap(s) {
    this.count(s, 'gaps');
    const at = this.o.now();
    if (s.noticedAt !== undefined && at - s.noticedAt < NOTICE_EVERY_MS) return;
    s.noticedAt = at;
    const notice = { id: `n_${at}_gap`, t: at, kind: 'event', ev: RESYNC_EVENT, patch: { reason: 'gap' } };
    this.o.notify(s.device.pairId, notice).catch((error) => {
      s.noticedAt = undefined;
      noteIgnored('tell a phone its counters are ahead', error);
    });
  }

  /** No more waiting for the relay. */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The channel stops: no more asking, and the frames waiting for budget give up. */
  shutdown() {
    this.stop();
    for (const wake of [...this.sleepers]) wake();
  }

  /** @param {{ dropped: number, duplicates: number }} channel */
  stats(channel) {
    return {
      dropped: channel.dropped,
      duplicates: channel.duplicates,
      gaps: this.gaps,
      pauses: { ...this.pauses },
      held: this.held,
      throttled: this.throttled,
      reopens: this.reopens,
      reconnects: this.reconnects,
      paused: [...this.o.sessions()].filter(paused).length,
    };
  }
}

module.exports = { SessionPauses, PAUSES, CATCH_UP_CHUNK, RESYNC_EVENT, newCounts, ended, paused };
