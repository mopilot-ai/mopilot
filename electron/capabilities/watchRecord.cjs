// Record a skill: one recording of what the person does with the mouse and keyboard, for a chat to turn into a skill. The helper reports
// their clicks and key presses (record.event, WatchRecord.swift) for the apps MoPilot could control; the recorder keeps them while
// the pill shows (watchRecordPill.cjs), and on Done turns them into the block the chat gets (watchRecordSteps.cjs), delivered like
// shared Computer History on every harness. One recording at a time on the Mac, owned by the chat that started it; it ends once,
// by Done, Discard, its time limit, the helper quitting or the app quitting.
const { stepsOf, recordingBlock, stamp } = require('./watchRecordSteps.cjs');
const { userError } = require('../../shared/userError.mjs');

/** The longest recording, how long before that the pill warns, and how many events are kept. */
const MAX_MS = 10 * 60_000;
const WARN_MS = 30_000;
const MAX_EVENTS = 5000;
/** How many times a record.stop is tried before the helper is left recording (it quits with main). */
const STOP_TRIES = 3;
const NEEDS_ACCESSIBILITY = 'Allow Accessibility for MoPilot in Settings → Computer use, then try again';

/**
 * @typedef {{ chatId: string, steps?: number, durationMs?: number, block?: string | null, limit?: false | 'time' | 'size', error?: string }} RecordingResult
 */

class WatchRecorder {
  /**
   * @param {object} o
   * @param {any} o.helper the computer-use helper
   * @param {{ available: boolean, show(): void, hide(): void, update(clock: string, warning?: string): void }} o.pill
   * @param {(result: RecordingResult) => void} o.onDone a recording ended: its block, or why it has none
   * @param {() => void} [o.onChange] recording started or ended
   * @param {(what: string, error: unknown) => void} o.note where an error that is survived is noted
   * @param {() => number} [o.now]
   * @param {number} [o.maxMs]
   * @param {number} [o.warnMs]
   */
  constructor(o) {
    this.helper = o.helper;
    this.pill = o.pill;
    this.onDone = o.onDone;
    this.onChange =
      o.onChange ??
      (() => {
        /* nobody follows the state */
      });
    this.note = o.note;
    this.now = o.now ?? Date.now;
    this.maxMs = o.maxMs ?? MAX_MS;
    this.warnMs = o.warnMs ?? WARN_MS;
    /** @type {{ chatId: string, startedAt: number, events: any[], listener: (e: any) => void, exited: () => void, helper: any, timer: ReturnType<typeof setInterval> | null, ending: boolean, limit: false | 'time' | 'size' } | null} */
    this.active = null;
    this.starting = false;
  }

  /** What the windows show: whether a recording runs and for which chat. */
  get state() {
    return { recording: !!this.active, chatId: this.active?.chatId ?? null, startedAt: this.active?.startedAt ?? null };
  }

  /**
   * Starts a recording for `chatId`.
   * @param {string} chatId
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async start(chatId) {
    if (this.active || this.starting) return { ok: false, error: 'A recording is already running' };
    const helper = this.helper;
    if (!this.pill.available) return { ok: false, error: 'Recording is not available in this session' };
    this.starting = true;
    try {
      const events = [];
      const listener = (e) => this.#event(e);
      helper.on('record', listener);
      const exited = () => void this.#end('error', 'The recording stopped because the computer-use helper quit', false);
      helper.once('exit', exited);
      try {
        let began = await helper.call('record.start');
        // a recording the helper still has from before (a stop that never arrived): ended, then started again
        if (began?.started === false) {
          await helper.call('record.stop');
          began = await helper.call('record.start');
          if (began?.started === false) throw new Error('The helper is still recording for an earlier request');
        }
      } catch (error) {
        helper.off('record', listener);
        helper.off('exit', exited);
        const permission = error?.reason === 'permission_denied' || error?.reason === 'permission';
        return { ok: false, error: permission ? NEEDS_ACCESSIBILITY : userError(error) };
      }
      this.active = { chatId, startedAt: this.now(), events, listener, helper, exited, timer: null, ending: false, limit: false };
      try {
        this.pill.show();
      } catch (error) {
        // the person is told by the dialog; the chat has nothing to hear
        await this.#end('discard');
        return { ok: false, error: userError(error) };
      }
      this.active.timer = setInterval(() => this.#tick(), 1000);
      this.active.timer.unref?.();
      this.#tick();
      this.onChange();
      return { ok: true };
    } finally {
      this.starting = false;
    }
  }

  /** The person clicked Done: the recording becomes a block for its chat. */
  done() {
    return this.#end('done');
  }

  /** The person clicked Discard (or the app is closing): nothing is kept. */
  discard() {
    return this.#end('discard');
  }

  dispose() {
    this.pill.hide();
    return this.#end('discard');
  }

  #event(e) {
    const a = this.active;
    if (!a || a.ending || !e || typeof e !== 'object' || typeof e.t !== 'number') return;
    a.events.push(e);
    // as long as the pill's own limit: the recording ends at its size, with what it has, and says so
    if (a.events.length >= MAX_EVENTS) {
      a.limit = 'size';
      void this.#end('done');
    }
  }

  /** The clock on the pill, and the end of the recording at its limit. */
  #tick() {
    // only the interval and start() call it, and the interval ends with the recording
    const a = /** @type {NonNullable<WatchRecorder['active']>} */ (this.active);
    const elapsed = this.now() - a.startedAt;
    const left = this.maxMs - elapsed;
    if (left <= 0) {
      a.limit = 'time';
      void this.#end('done');
      return;
    }
    this.pill.update(stamp(elapsed), left <= this.warnMs ? `${Math.ceil(left / 1000)} s left` : '');
  }

  /**
   * Ends the recording once. 'done' hands the chat its block, 'discard' keeps nothing, 'error' tells the chat why it has none.
   * @param {'done' | 'discard' | 'error'} how
   * @param {string} [error]
   * @param {boolean} [stopHelper] false when the helper is gone and would only be launched to be told
   */
  async #end(how, error, stopHelper = true) {
    const a = this.active;
    if (!a || a.ending) return;
    a.ending = true;
    if (a.timer) clearInterval(a.timer);
    this.pill.hide();
    a.helper.off('record', a.listener);
    a.helper.off('exit', a.exited);
    // the helper may be gone already (the app is closing): nothing more is recorded either way
    // a stop that does not arrive leaves the helper recording, so it is tried again
    for (let i = 0; stopHelper && i < STOP_TRIES; i++) {
      try {
        await a.helper.call('record.stop');
        break;
      } catch (e) {
        if (e?.reason === 'helper_not_running') break;
        this.note('stop the recording in the helper', e);
      }
    }
    this.active = null;
    this.onChange();
    if (how === 'discard') return;
    const durationMs = Math.max(0, this.now() - a.startedAt);
    if (how === 'error') return this.onDone({ chatId: a.chatId, error });
    const steps = stepsOf(a.events);
    this.onDone({ chatId: a.chatId, steps: steps.length, durationMs, block: recordingBlock(steps, { durationMs }), limit: a.limit });
  }
}

module.exports = { WatchRecorder, MAX_MS, WARN_MS, MAX_EVENTS, NEEDS_ACCESSIBILITY };
