// Computer History's recorder (#1363), in main and needing no window: while on, not paused and not suspended (screen locked, asleep, quitting) it takes one activity sample every few seconds while the user is active, passes it through the policy gate and grows the open entry, writing each entry once it closes. Pause, a lock, sleep, quit, a settings change and Delete all stop it at once: they bump the generation, so a sample still in flight is dropped when it lands.
const { noteIgnored } = require('../ignored.cjs');
const { admitSample, allowApp, allowSite, RETENTION_DAYS } = require('./policy.cjs');
const { SAMPLE_MS, dayKey, extend } = require('./segments.cjs');

/**
 * What the user reads for each failure. A raw error (a helper path, a file name) goes to Copy diagnostics only, so
 * nothing local and nothing the user can't act on is shown.
 */
const FAILURE_TEXT = Object.freeze({
  'needs-permission': 'Computer History needs Accessibility for MoPilot. Turn it on in System Settings.',
  unavailable: "Computer History can't reach MoPilot Computer Use right now. It tries again every few seconds.",
  'store-unavailable': "Computer History can't save on this Mac right now, so it keeps what it recorded and tries again.",
});

/** Seconds without keyboard or mouse input after which nothing is recorded. */
const IDLE_LIMIT_S = 120;
/** Entries kept in memory while the store can't take them, oldest dropped first. */
const MAX_PENDING = 500;

/**
 * @typedef {import('./policy.cjs').Settings} Settings
 * @typedef {import('./segments.cjs').Entry} Entry
 * @typedef {'off' | 'recording' | 'paused' | 'suspended' | 'needs-permission' | 'unavailable' | 'store-unavailable'} Status
 * @typedef {'locked' | 'asleep' | 'quit'} SuspendReason
 * @typedef {{ status: Status, settings: Settings, suspended: SuspendReason[], error: string | null, settingsError: string | null }} RecorderState
 */

class Recorder {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('./store.cjs').HistoryStore>} o.store
   * @param {(settings: Settings) => Promise<unknown>} o.sample the frontmost app's activity sample (the helper's
   *   activity.sample, which reads only the apps `settings` allows), or `{ error: 'needs-permission' | 'unavailable' }`
   * @param {() => Promise<number>} o.idleSeconds seconds since the user's last input
   * @param {() => boolean} [o.locked] whether the screen is locked now (checked on every tick as well as on events)
   * @param {() => string[]} [o.userDeny] the user's computer-use deny list
   * @param {(state: RecorderState) => void} [o.onChange]
   * @param {() => number} [o.now]
   * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
   * @param {number} [o.intervalMs]
   */
  constructor(o) {
    this.store = o.store;
    this.sampleNow = o.sample;
    this.idleSeconds = o.idleSeconds;
    this.locked = o.locked ?? (() => false);
    this.userDeny = o.userDeny ?? (() => []);
    this.onChange = o.onChange ?? (() => undefined);
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? { setInterval, clearInterval };
    this.intervalMs = o.intervalMs ?? SAMPLE_MS;
    /** @type {Settings} */
    this.settings = this.store.readSettings();
    /** @type {Set<SuspendReason>} */
    this.suspended = new Set();
    /** @type {Entry | null} the entry the latest samples grow, not yet written */
    this.open = null;
    /** @type {Entry[]} closed entries the store could not take yet */
    this.pending = [];
    /** @type {string | null} why the latest sample or write failed */
    this.error = null;
    /** @type {Status | null} */
    this.errorStatus = null;
    this.gen = 0;
    this.busy = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    this.lastDay = dayKey(this.now());
    this.#prune();
    this.#sync();
  }

  /** @returns {Status} */
  get status() {
    const s = this.settings;
    if (!s.enabled) return 'off';
    if (s.paused) return 'paused';
    if (this.suspended.size) return 'suspended';
    return this.errorStatus ?? 'recording';
  }

  /** @returns {RecorderState} */
  get state() {
    return {
      status: this.status,
      settings: this.settings,
      suspended: [...this.suspended],
      error: this.error,
      settingsError: this.store.settingsError ? 'The saved Computer History settings could not be read, so it is off.' : null,
    };
  }

  /** Whether samples are being taken now. */
  get running() {
    return !!this.timer;
  }

  /** One sample. Skipped while one is in flight; dropped when the generation moved while it was taken. */
  async tick() {
    if (this.busy || !this.timer) return;
    this.busy = true;
    const gen = this.gen;
    const live = () => gen === this.gen;
    try {
      const day = dayKey(this.now());
      if (day !== this.lastDay) {
        this.lastDay = day;
        this.#prune();
      }
      if (this.locked()) return this.#close();
      const idle = await this.idleSeconds();
      if (!live()) return;
      if (!(idle < IDLE_LIMIT_S)) return this.#close();
      const raw = await this.sampleNow(this.settings);
      if (!live()) return;
      const failure = raw && typeof raw === 'object' && 'error' in raw ? raw.error : null;
      if (failure === 'needs-permission' || failure === 'unavailable') {
        this.#close();
        return this.#fail(failure, /** @type {any} */ (raw).cause);
      }
      // only main reports the built-in browser: whatever the helper says, its sample is an app's
      const r = admitSample(raw && typeof raw === 'object' ? { ...raw, source: 'app' } : raw, this.settings, { userDeny: this.userDeny() });
      this.#clear('needs-permission', 'unavailable');
      if ('drop' in r) return this.#close();
      const { open, closed } = extend(this.open, r.activity, this.now());
      this.open = open;
      if (closed) this.#write([closed]);
    } catch (error) {
      if (live()) {
        this.#close();
        this.#fail('unavailable', error);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Turns recording on or off. */
  setEnabled(on) {
    return this.#update((s) => ({ ...s, enabled: !!on, paused: false }));
  }

  pause() {
    return this.#update((s) => ({ ...s, paused: true }));
  }

  resume() {
    return this.#update((s) => ({ ...s, paused: false }));
  }

  /** @param {unknown} app */
  allowApp(app) {
    const r = allowApp(this.settings, app, this.userDeny());
    if (!r.ok) return r;
    this.#update(() => r.settings);
    return { ok: true };
  }

  /** @param {string} bundleId */
  removeApp(bundleId) {
    return this.#update((s) => ({ ...s, apps: s.apps.filter((a) => a.bundleId !== bundleId) }));
  }

  /** @param {unknown} input */
  allowSite(input) {
    const r = allowSite(this.settings, input);
    if (!r.ok) return r;
    this.#update(() => r.settings);
    return { ok: true, site: r.site };
  }

  /** @param {string} site */
  removeSite(site) {
    return this.#update((s) => ({ ...s, sites: s.sites.filter((x) => x !== site) }));
  }

  /** @param {number} days */
  setRetention(days) {
    if (!RETENTION_DAYS.includes(days)) return { ok: false, reason: `Keep for ${RETENTION_DAYS.join(', ')} days` };
    this.#update((s) => ({ ...s, retentionDays: days }));
    this.#prune();
    return { ok: true };
  }

  markExplainerSeen() {
    return this.#update((s) => ({ ...s, explainerSeen: true }));
  }

  /** The screen locked, the Mac went to sleep or the app is quitting: nothing is recorded until wake(). */
  suspend(/** @type {SuspendReason} */ reason) {
    if (this.suspended.has(reason)) return;
    this.suspended.add(reason);
    this.#sync();
  }

  wake(/** @type {SuspendReason} */ reason) {
    if (!this.suspended.delete(reason)) return;
    this.#sync();
  }

  /**
   * The entries of some days, newest day first, with the open entry for its day; unreadable lines counted.
   * @param {string[]} days
   */
  entries(days) {
    const out = [];
    let unreadable = 0;
    for (const day of days) {
      const r = this.store.readDay(day);
      unreadable += r.unreadable;
      out.push(...r.entries, ...this.pending.filter((e) => dayKey(e.start) === day));
      if (this.open && dayKey(this.open.start) === day) out.push(this.open);
    }
    return { entries: out, unreadable };
  }

  /** Removes one day, the open entry and anything still waiting to be written for it included. */
  deleteDay(day) {
    this.store.deleteDay(day);
    this.gen++;
    if (this.open && dayKey(this.open.start) === day) this.open = null;
    this.pending = this.pending.filter((e) => dayKey(e.start) !== day);
    this.onChange(this.state);
  }

  /** Removes everything recorded, on disk and in memory; the settings stay. */
  deleteAll() {
    this.gen++;
    this.open = null;
    this.pending = [];
    this.store.deleteAll();
    this.onChange(this.state);
  }

  /** Stops sampling for good (main is going away); what was recorded is written first. */
  dispose() {
    this.suspend('quit');
  }

  /** @param {(s: Settings) => Settings} fn */
  #update(fn) {
    // a sample taken under the old rules never lands under the new ones
    this.gen++;
    this.#close();
    this.settings = this.store.writeSettings(fn(this.settings));
    this.#sync();
    return { ok: true };
  }

  /** Starts or stops the timer for what the settings and suspensions say now. */
  #sync() {
    const run = this.settings.enabled && !this.settings.paused && !this.suspended.size;
    if (run && !this.timer) {
      this.timer = this.timers.setInterval(() => void this.tick(), this.intervalMs);
    } else if (!run && this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
      this.gen++;
      this.#close();
    }
    if (!this.settings.enabled) this.#clear('needs-permission', 'unavailable', 'store-unavailable');
    this.onChange(this.state);
  }

  /** The open entry is written and nothing grows any more. */
  #close() {
    const open = this.open;
    this.open = null;
    if (open) this.#write([open]);
  }

  /** @param {Entry[]} entries */
  #write(entries) {
    const all = [...this.pending, ...entries];
    try {
      this.store.append(all);
      this.pending = [];
      this.#clear('store-unavailable');
    } catch (error) {
      // only what did not reach the disk is kept for the next write
      const unwritten = /** @type {any} */ (error)?.unwritten;
      this.pending = (Array.isArray(unwritten) ? unwritten : all).slice(-MAX_PENDING);
      this.#fail('store-unavailable', error);
    }
    this.onChange(this.state);
  }

  #prune() {
    try {
      this.store.prune(this.settings.retentionDays, this.now());
    } catch (error) {
      // the next day change, retention change or start tries again
      noteIgnored('remove Computer History days past their retention', error);
    }
  }

  /**
   * The status shows a failure. Its raw cause goes to Copy diagnostics once, when the failure starts, not on every
   * tick that sees it again.
   * @param {keyof typeof FAILURE_TEXT} status
   * @param {unknown} [cause]
   */
  #fail(status, cause) {
    const changed = this.errorStatus !== status;
    if (changed && cause !== undefined) noteIgnored(`Computer History: ${FAILURE_TEXT[status]}`, cause);
    this.errorStatus = status;
    this.error = FAILURE_TEXT[status];
    if (changed) this.onChange(this.state);
  }

  /** @param {...Status} statuses the failures that are over */
  #clear(...statuses) {
    if (!this.errorStatus || !statuses.includes(this.errorStatus)) return;
    this.errorStatus = null;
    this.error = null;
    this.onChange(this.state);
  }
}

module.exports = { Recorder, IDLE_LIMIT_S, MAX_PENDING, FAILURE_TEXT };
